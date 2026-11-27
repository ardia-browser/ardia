use crate::scale::px;
use ardia_state::{Action, ProfileId};
use gpui::{
    AnyElement, ClipboardItem, Context, Entity, FontWeight, IntoElement, ParentElement,
    SharedString, Styled, Subscription, Window, div, prelude::*,
};
use serde_json::Value;

use crate::look::Palette;
use crate::msg::Msg;
use crate::primitives::controls::{
    ButtonKind, IconButton, MenuRow, PushButton, Toggle, field_box, popover,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::list::{Row, group};
use crate::primitives::text_input::{InputEvent, TextInput, focus_input, text_field_style};
use crate::primitives::virtual_list::virtual_list;
use crate::settings::SettingsWindowView;
use crate::settings::data::{
    self, InstalledExtension, SavedAddress, SavedCard, SavedPassword, Secret, SettingsCall,
    SettingsQuery,
};
use crate::settings::memo::{
    DESCRIBED_ROW_ESTIMATE, Listed, ROW_ESTIMATE, Same, divided, grouped_list,
};
use crate::settings::panes::{self, Block};

pub const COMMAND: &str = "settings:sub:";
pub const OPEN: &str = "settings:sub:open:";
pub const OPEN_PASSWORDS: &str = "settings:sub:open:passwords";
pub const OPEN_ADDRESSES: &str = "settings:sub:open:addresses";
pub const OPEN_CARDS: &str = "settings:sub:open:cards";
pub const OPEN_SITES: &str = "settings:sub:open:sites";
pub const OPEN_OTHER_ENGINES: &str = "settings:sub:open:otherEngines";
pub const EXPORT_BOOKMARKS: &str = "settings:sub:exportBookmarks";
pub const SECTION_TOP: f32 = 20.0;
pub const SUBPAGE_TOP: f32 = 35.0;
pub const FIELD_WIDTH: f32 = 250.0;
pub const SEARCH_WIDTH: f32 = 200.0;
pub const DETAILS_ICON: f32 = 48.0;
pub const EMPTY_TOP: f32 = 40.0;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Detail {
    Passwords,
    Addresses,
    Cards,
    Sites,
    Site(String),
    OtherEngines,
    Extension(String),
    FilterLists,
    CrashDetails,
    Plugin(String),
}

impl Detail {
    pub fn key(&self) -> String {
        match self {
            Detail::Passwords => "passwords".into(),
            Detail::Addresses => "addresses".into(),
            Detail::Cards => "cards".into(),
            Detail::Sites => "sites".into(),
            Detail::Site(origin) => format!("site:{origin}"),
            Detail::OtherEngines => "otherEngines".into(),
            Detail::Extension(id) => format!("extension:{id}"),
            Detail::FilterLists => "filterLists".into(),
            Detail::CrashDetails => "crashDetails".into(),
            Detail::Plugin(name) => format!("plugin:{name}"),
        }
    }

    pub fn parse(key: &str) -> Option<Detail> {
        Some(match key {
            "passwords" => Detail::Passwords,
            "addresses" => Detail::Addresses,
            "cards" => Detail::Cards,
            "sites" => Detail::Sites,
            "otherEngines" => Detail::OtherEngines,
            "filterLists" => Detail::FilterLists,
            "crashDetails" => Detail::CrashDetails,
            other => {
                if let Some(origin) = other.strip_prefix("site:").filter(|o| !o.is_empty()) {
                    Detail::Site(origin.to_owned())
                } else if let Some(name) = other.strip_prefix("plugin:").filter(|n| !n.is_empty()) {
                    Detail::Plugin(name.to_owned())
                } else {
                    let id = other.strip_prefix("extension:").filter(|i| !i.is_empty())?;
                    Detail::Extension(id.to_owned())
                }
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Sheet {
    Password {
        saved: SavedPassword,
        revealed: Option<String>,
        shown: bool,
        editing: bool,
        busy: bool,
        error: Option<String>,
    },
    Address {
        saved: Option<SavedAddress>,
    },
    Card {
        saved: Option<SavedCard>,
        number_shown: bool,
        month: Option<u32>,
        year: Option<i32>,
        error: Option<String>,
    },
    Engine {
        id: Option<String>,
        error: Option<String>,
    },
    ResetId {
        done: Option<String>,
    },
    ExtensionInstall {
        name: String,
        icon: Option<String>,
        warnings: Vec<String>,
        path: String,
        error: Option<String>,
        busy: bool,
    },
    AddSite {
        name: String,
        error: Option<String>,
        saving: bool,
    },
    EngineRule {
        site: Option<String>,
        engine: ardia_state::model::PageEngine,
        error: Option<&'static str>,
    },
    EnginesDiffer,
    WebKitLimits,
}

#[derive(Default)]
pub struct SubState {
    pub detail: Option<Detail>,
    pub sheet: Option<Sheet>,
    pub fields: Vec<Entity<TextInput>>,
    pub search: Option<Entity<TextInput>>,
    pub query: String,
    pub import_status: Option<String>,
    pub export_status: Option<String>,
    pub site_status: Option<(String, String)>,
    pub bookmarks_status: Option<String>,
    pub bookmarks_busy: bool,
    pub list_input: Option<Entity<TextInput>>,
    pub list_typed: String,
    pub list_tried: bool,
    pub list_note: Option<(String, bool)>,
    pub data_status: Option<String>,
    pub data_busy: bool,
    pub blocker_asked: std::cell::Cell<bool>,
    pub hidden_profile: Option<ProfileId>,
    pub site_problem: Option<(String, String)>,
    pub engine_pending: Option<ardia_state::settings::EngineMode>,
    pub(crate) list_watch: Option<Subscription>,
    pub(crate) memo: crate::settings::memo::Memos,
    subscriptions: Vec<Subscription>,
    search_watch: Option<Subscription>,
}

impl SubState {
    pub fn sheet_open(&self) -> bool {
        self.sheet.is_some()
    }
}

fn cmd(text: impl Into<String>) -> Msg {
    Msg::Command(SharedString::from(text.into()))
}

fn profile_of(view: &SettingsWindowView) -> Option<ProfileId> {
    panes::selected_profile(view)
}

fn value(view: &SettingsWindowView, query: SettingsQuery) -> Option<Value> {
    view.host.settings_value(&query)
}

pub fn open_detail(
    view: &mut SettingsWindowView,
    detail: Option<Detail>,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    view.sub.sheet = None;
    view.sub.fields.clear();
    view.sub.subscriptions.clear();
    view.sub.query.clear();
    view.sub.import_status = None;
    view.sub.export_status = None;
    view.sub.site_status = None;
    if detail == Some(Detail::Passwords) {
        let search = view
            .sub
            .search
            .get_or_insert_with(|| cx.new(|cx| TextInput::new("Search", cx)));
        let search = search.clone();
        let style = text_field_style(&view.look);
        search.update(cx, |input, cx| {
            input.set_style(style, cx);
            input.set_text("", false, cx);
        });
        view.sub.search_watch =
            Some(
                cx.subscribe_in(&search, window, |view, input, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Changed { .. }) {
                        view.sub.query = input.read(cx).text().to_owned();
                        cx.notify();
                    }
                }),
            );
    }
    if detail == Some(Detail::FilterLists) {
        crate::settings::general_subpages::prepare_list_input(view, window, cx);
        view.host
            .content_blocker_command(crate::site::model::ContentBlockerCommand::Refresh);
    }
    if detail == Some(Detail::CrashDetails) {
        view.sub.data_status = None;
    }
    view.visit_detail(detail, cx);
}

pub fn blocks(view: &SettingsWindowView) -> Option<Vec<Block>> {
    let detail = view.sub.detail.clone()?;
    let element = match detail {
        Detail::FilterLists => crate::settings::general_subpages::filter_lists_page(view),
        Detail::CrashDetails => crate::settings::general_subpages::crash_details_page(view),
        Detail::Plugin(name) => crate::settings::extras::plugin_page(view, &name),
        detail => profile_detail(view, detail)?,
    };
    Some(vec![Block {
        rows: Vec::new(),
        element: div().mt(px(SUBPAGE_TOP)).child(element).into_any_element(),
    }])
}

fn profile_detail(view: &SettingsWindowView, detail: Detail) -> Option<AnyElement> {
    let profile = profile_of(view)?;
    Some(match detail {
        Detail::Passwords => passwords_page(view, &profile),
        Detail::Addresses => addresses_page(view, &profile),
        Detail::Cards => cards_page(view, &profile),
        Detail::Sites => sites_page(view, &profile),
        Detail::Site(origin) => site_page(view, &profile, &origin),
        Detail::OtherEngines => other_engines_page(view),
        Detail::Extension(id) => extension_page(view, &profile, &id),
        Detail::FilterLists | Detail::CrashDetails | Detail::Plugin(_) => return None,
    })
}

pub fn header(
    p: &Palette,
    title: impl Into<SharedString>,
    detail: Option<SharedString>,
    action: Option<AnyElement>,
) -> AnyElement {
    div()
        .mt(px(SECTION_TOP))
        .mb(px(6.))
        .px(px(6.))
        .flex()
        .flex_row()
        .items_end()
        .gap(px(8.))
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
                }),
        )
        .children(action)
        .into_any_element()
}

fn first_header(
    p: &Palette,
    title: impl Into<SharedString>,
    detail: Option<SharedString>,
    action: Option<AnyElement>,
) -> AnyElement {
    header(p, title, detail, action)
}

fn tagged(selector: String, element: impl IntoElement) -> AnyElement {
    div()
        .debug_selector(move || selector)
        .child(element)
        .into_any_element()
}

pub(crate) trait TitleLine {
    fn title_line(self, title: impl Into<SharedString>) -> Self;
}

impl TitleLine for Row {
    fn title_line(self, title: impl Into<SharedString>) -> Self {
        self.title_element(
            div()
                .text_size(px(13.))
                .line_height(px(16.))
                .child(title.into()),
        )
    }
}

fn row(id: impl Into<SharedString>, p: &Palette) -> Row {
    let id: SharedString = id.into();
    Row::new(gpui::ElementId::Name(id), p).native(true)
}

fn button(
    view: &SettingsWindowView,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    msg: Msg,
) -> PushButton {
    let id: SharedString = id.into();
    PushButton::new(gpui::ElementId::Name(id), label, &view.look.p).on_click(view.emit.click(msg))
}

fn glyph_button(
    view: &SettingsWindowView,
    id: impl Into<SharedString>,
    glyph: Icon,
    tooltip: &'static str,
    msg: Msg,
) -> AnyElement {
    let id: SharedString = id.into();
    let p = view.look.p;
    IconButton::new(gpui::ElementId::Name(id), glyph, &p)
        .square(24., 5.)
        .glyph(13.)
        .tooltip(tooltip, &p)
        .on_click(view.emit.click(msg))
        .into_any_element()
}

fn toggle_control(
    view: &SettingsWindowView,
    id: impl Into<SharedString>,
    on: bool,
    disabled: bool,
    msg: impl Fn(bool) -> Msg + 'static,
) -> AnyElement {
    let id: SharedString = id.into();
    let emit = view.emit.clone();
    let selector = id.clone();
    div()
        .debug_selector(move || selector.to_string())
        .child(
            Toggle::new(gpui::ElementId::Name(id), on, &view.look.p)
                .native(true)
                .disabled(disabled)
                .on_toggle(move |value, window, cx| emit.send(msg(value), window, cx)),
        )
        .into_any_element()
}

pub(crate) fn site_icon(
    view: &SettingsWindowView,
    profile: &ProfileId,
    url: &str,
    side: f32,
) -> AnyElement {
    let p = view.look.p;
    let favicon = match view.host.page_favicon(profile, url) {
        Some(image) => crate::primitives::favicon::Favicon::Image(image),
        None => crate::primitives::favicon::favicon_of(url, None, None, ""),
    };
    div()
        .flex_none()
        .size(px(20.))
        .flex()
        .items_center()
        .justify_center()
        .child(crate::primitives::favicon::render_favicon(
            &favicon, side, &p,
        ))
        .into_any_element()
}

pub struct MenuItem {
    pub label: SharedString,
    pub checked: bool,
    pub command: String,
}

pub fn menu_popup(
    view: &SettingsWindowView,
    id: String,
    label: impl Into<SharedString>,
    min_width: f32,
    items: Vec<MenuItem>,
) -> AnyElement {
    let p = view.look.p;
    let open = view.menu.as_deref() == Some(id.as_str());
    let selector = id.clone();
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
                        items
                            .iter()
                            .map(|item| {
                                crate::primitives::pop_up_menu::PopUpChoice::new(
                                    item.label.clone(),
                                    item.checked,
                                    vec![cmd(item.command.clone())],
                                )
                            })
                            .collect(),
                        Msg::Command(panes::menu_command(&id)),
                    )),
                ),
        )
        .when(open, |this| {
            let width = min_width.max(160.);
            let menu_id = id.clone();
            this.child(
                gpui::deferred(
                    popover(
                        SharedString::from(format!("popup-menu:{id}")),
                        false,
                        width,
                        &p,
                    )
                    .debug_selector(move || format!("popup-menu:{menu_id}"))
                    .absolute()
                    .top(px(panes::POPUP_HEIGHT + 2.))
                    .right_0()
                    .children(items.into_iter().enumerate().map(|(index, item)| {
                        let emit = view.emit.clone();
                        let command = item.command;
                        MenuRow::new(
                            SharedString::from(format!("popup-item:{id}:{index}")),
                            item.label,
                            &p,
                        )
                        .checked(item.checked)
                        .on_click(move |_, window, cx| {
                            emit.send(Msg::CloseOverlays, window, cx);
                            emit.send(cmd(command.clone()), window, cx);
                        })
                    })),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

fn unlocked(view: &SettingsWindowView, profile: &ProfileId) -> bool {
    value(view, SettingsQuery::PasswordsUnlocked(profile.clone()))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

pub fn password_manager_apps_note(in_applications: bool) -> &'static str {
    if in_applications {
        "1Password, Bitwarden, KeePassXC and Proton Pass extensions connect to their Mac apps. For 1Password, add Ardia once: in the 1Password app, open Settings › Browser › Add Browser and choose Ardia."
    } else {
        "1Password, Bitwarden, KeePassXC and Proton Pass extensions connect to their Mac apps. For 1Password, move Ardia to your Applications folder and reopen it (1Password only connects to browsers there), then in the 1Password app open Settings › Browser › Add Browser and choose it."
    }
}

fn in_applications_folder() -> bool {
    std::env::current_exe()
        .map(|path| path.starts_with("/Applications"))
        .unwrap_or(true)
}

fn passwords_page(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let mut out: Vec<AnyElement> = vec![first_header(
        &p,
        "Passwords",
        Some(SharedString::new_static(
            "Saved on this Mac, separately for each profile, and encrypted with a key in your Keychain.",
        )),
        None,
    )];
    out.push(
        group(
            &p,
            [
                row("passwords-import", &p)
                    .title_line("Import passwords")
                    .description(view.sub.import_status.clone().unwrap_or_else(|| {
                        "From a CSV exported by Chrome, Safari, Firefox, 1Password, Bitwarden…"
                            .to_owned()
                    }))
                    .child(button(
                        view,
                        "passwords-import-button",
                        "Import CSV…",
                        cmd(format!("{COMMAND}importPasswords")),
                    ))
                    .into_any_element(),
                row("passwords-export", &p)
                    .title_line("Export passwords")
                    .description(view.sub.export_status.clone().unwrap_or_else(|| {
                        "To a CSV file. Anyone who can open the file can read your passwords."
                            .to_owned()
                    }))
                    .child(button(
                        view,
                        "passwords-export-button",
                        "Export CSV…",
                        cmd(format!("{COMMAND}exportPasswords")),
                    ))
                    .into_any_element(),
                row("passwords-apps", &p)
                    .icon(
                        div()
                            .flex_none()
                            .size(px(20.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::QuestionCircle, 15., p.icon)),
                    )
                    .title_line("Password manager apps")
                    .description(password_manager_apps_note(in_applications_folder()))
                    .into_any_element(),
            ],
        )
        .into_any_element(),
    );
    if !unlocked(view, profile) {
        out.push(
            div()
                .debug_selector(|| "passwords-locked".into())
                .mt(px(EMPTY_TOP))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(8.))
                .child(icon(Icon::LockFill, 26., p.text_tertiary))
                .child(
                    div()
                        .text_size(px(15.))
                        .font_weight(FontWeight::MEDIUM)
                        .child("Passwords are locked"),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(p.text_secondary)
                        .child("Unlock with Touch ID or your login password to see them."),
                )
                .child(tagged(
                    "passwords-unlock".into(),
                    button(
                        view,
                        "passwords-unlock",
                        "Unlock",
                        cmd(format!("{COMMAND}unlock")),
                    )
                    .kind(ButtonKind::Primary),
                ))
                .into_any_element(),
        );
        return div().children(out).into_any_element();
    }
    let list = view.sub.memo.passwords.get(
        view.host.as_ref(),
        SettingsQuery::Passwords(profile.clone()),
        |value| {
            value.as_ref().map(|v| {
                data::passwords_of(v)
                    .into_iter()
                    .map(PasswordRow::new)
                    .collect()
            })
        },
    );
    let query = view.sub.query.clone();
    let title = match list.as_ref() {
        Some(list) => data::plural(list.len(), "Saved Password"),
        None => "Saved Passwords".to_owned(),
    };
    let search = view.sub.search.clone().map(|search| {
        field_box(&p)
            .debug_selector(|| "passwords-search".into())
            .w(px(SEARCH_WIDTH))
            .h(px(22.))
            .child(icon(Icon::Search, 11., p.text_tertiary))
            .child(div().flex_1().min_w_0().child(search))
            .into_any_element()
    });
    out.push(header(&p, title, None, search));
    let shown =
        view.sub
            .memo
            .passwords_shown
            .get((Same(list.clone()), query.clone()), |(list, query)| {
                let wanted = query.trim().to_lowercase();
                let indices = list
                    .0
                    .iter()
                    .flatten()
                    .enumerate()
                    .filter(|(_, saved)| saved.matches(&wanted))
                    .map(|(index, _)| index)
                    .collect();
                Listed::new(
                    indices,
                    |index| format!("password:{index}"),
                    |_| DESCRIBED_ROW_ESTIMATE,
                )
            });
    if list.is_some() && shown.rows.is_empty() {
        out.push(
            group(
                &p,
                [row("passwords-none", &p)
                    .title_line(if query.trim().is_empty() {
                        "No saved passwords"
                    } else {
                        "No passwords match"
                    })
                    .into_any_element()],
            )
            .into_any_element(),
        );
    } else {
        let saved_rows = list.as_deref().unwrap_or_default();
        out.push(grouped_list(
            &p,
            format!("settings:passwords:{profile}"),
            &view.scroll,
            shown.items.clone(),
            |ix| {
                let index = shown.rows[ix];
                let saved = &saved_rows[index].saved;
                let username = if saved.username.is_empty() {
                    "(no username)".to_owned()
                } else {
                    saved.username.clone()
                };
                let emit = view.emit.clone();
                let open = format!("{COMMAND}password:{index}");
                tagged(
                    format!("password:{index}"),
                    row(format!("password:{index}"), &p)
                        .icon(site_icon(view, profile, &saved.origin, 16.))
                        .title_line(data::host_label(&saved.origin))
                        .description(username)
                        .on_click(move |_, window, cx| emit.send(cmd(open.clone()), window, cx)),
                )
            },
        ));
    }
    let never = view.sub.memo.never_saved.get(
        view.host.as_ref(),
        SettingsQuery::NeverSaved(profile.clone()),
        |value| {
            Listed::new(
                value
                    .as_ref()
                    .map(|v| data::origins_of(v, "origins"))
                    .unwrap_or_default(),
                |origin| format!("never:{origin}"),
                |_| ROW_ESTIMATE,
            )
        },
    );
    if !never.rows.is_empty() {
        out.push(header(
            &p,
            "Never saved",
            Some(SharedString::new_static(
                "Sites where you chose “Never on This Site”.",
            )),
            None,
        ));
        out.push(grouped_list(
            &p,
            format!("settings:neverSaved:{profile}"),
            &view.scroll,
            never.items.clone(),
            |ix| {
                let origin = &never.rows[ix];
                row(format!("never:{origin}"), &p)
                    .icon(site_icon(view, profile, origin, 16.))
                    .title_line(data::host_label(origin))
                    .child(button(
                        view,
                        format!("never-remove:{origin}"),
                        "Remove",
                        cmd(format!("{COMMAND}allowSaving:{origin}")),
                    ))
                    .into_any_element()
            },
        ));
    }
    div().children(out).into_any_element()
}

fn addresses_page(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let list =
        value(view, SettingsQuery::Addresses(profile.clone())).map(|v| data::addresses_of(&v));
    let rows: Vec<AnyElement> = match &list {
        Some(list) if list.is_empty() => vec![
            row("addresses-none", &p)
                .title_line("No saved addresses")
                .description("Addresses you enter in forms can be saved here.")
                .into_any_element(),
        ],
        _ => list
            .iter()
            .flatten()
            .map(|address| {
                let emit = view.emit.clone();
                let open = format!("{COMMAND}address:{}", address.id);
                row(format!("address:{}", address.id), &p)
                    .icon(
                        div()
                            .flex_none()
                            .size(px(22.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::PersonCropCircle, 15., p.icon)),
                    )
                    .title_line(address.title())
                    .description(address.summary())
                    .on_click(move |_, window, cx| emit.send(cmd(open.clone()), window, cx))
                    .into_any_element()
            })
            .collect(),
    };
    div()
        .child(first_header(
            &p,
            "Addresses",
            Some(SharedString::new_static(
                "Names, addresses, email addresses and phone numbers.",
            )),
            Some(
                button(
                    view,
                    "address-add",
                    "Add Address…",
                    cmd(format!("{COMMAND}address:new")),
                )
                .into_any_element(),
            ),
        ))
        .child(group(&p, rows))
        .into_any_element()
}

fn now_year_month() -> (i32, u32) {
    use chrono::Datelike;
    let now = chrono::Local::now();
    (now.year(), now.month())
}

fn cards_page(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let (year, month) = now_year_month();
    let list = value(view, SettingsQuery::Cards(profile.clone())).map(|v| data::cards_of(&v));
    let rows: Vec<AnyElement> = match &list {
        Some(list) if list.is_empty() => vec![
            row("cards-none", &p)
                .title_line("No saved cards")
                .description("Cards you enter at checkout can be saved here.")
                .into_any_element(),
        ],
        _ => list
            .iter()
            .flatten()
            .map(|card| {
                let emit = view.emit.clone();
                let open = format!("{COMMAND}card:{}", card.id);
                row(format!("card:{}", card.id), &p)
                    .icon(crate::site::parts::network_badge(
                        view.host.as_ref(),
                        &card.network,
                    ))
                    .title_line(card.title())
                    .description(card.summary(year, month))
                    .on_click(move |_, window, cx| emit.send(cmd(open.clone()), window, cx))
                    .into_any_element()
            })
            .collect(),
    };
    div()
        .child(first_header(
            &p,
            "Cards",
            Some(SharedString::new_static(
                "Showing or filling a card asks for Touch ID or your login password. Card numbers are kept in your Keychain.",
            )),
            Some(
                button(view, "card-add", "Add Card…", cmd(format!("{COMMAND}card:new")))
                    .into_any_element(),
            ),
        ))
        .child(group(&p, rows))
        .into_any_element()
}

fn sites_page(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let settings = &view.state.settings;
    let mut out: Vec<AnyElement> = vec![first_header(
        &p,
        "All sites",
        Some(SharedString::new_static(
            "Defaults for every site. These apply in every profile.",
        )),
        None,
    )];
    out.push(
        group(
            &p,
            [
                row("sites-autoplay", &p)
                    .title_line("Block autoplay on every site")
                    .description(
                        "Sites you allow in Site Controls still autoplay. Chromium tabs only.",
                    )
                    .child(toggle_control(
                        view,
                        "toggle:blockAutoplayEverywhere",
                        settings.block_autoplay_everywhere,
                        false,
                        |on| panes::set("blockAutoplayEverywhere", on),
                    ))
                    .into_any_element(),
                row("sites-notifications", &p)
                    .title_line("Block requests to send notifications")
                    .description(
                        "Sites that ask are blocked. Sites you already allowed keep sending them.",
                    )
                    .child(toggle_control(
                        view,
                        "toggle:blockNotificationRequests",
                        settings.block_notification_requests,
                        false,
                        |on| panes::set("blockNotificationRequests", on),
                    ))
                    .into_any_element(),
            ],
        )
        .into_any_element(),
    );
    out.push(header(
        &p,
        "Sites",
        Some(SharedString::new_static(
            "Sites you allowed or blocked something for in this profile.",
        )),
        None,
    ));
    let origins = view.sub.memo.origins.get(
        view.host.as_ref(),
        SettingsQuery::SiteOrigins(profile.clone()),
        |value| {
            value.as_ref().map(|v| {
                Listed::new(
                    data::origins_of(v, "origins"),
                    |origin| format!("site:{origin}"),
                    |_| ROW_ESTIMATE,
                )
            })
        },
    );
    let placeholder = match origins.as_ref() {
        None => Some(
            row("sites-loading", &p)
                .title_line(" ")
                .description(" ")
                .into_any_element(),
        ),
        Some(list) if list.rows.is_empty() => Some(
            row("sites-none", &p)
                .title_line("No sites yet")
                .description("Sites appear here after you allow or block something for them.")
                .into_any_element(),
        ),
        Some(_) => None,
    };
    match (placeholder, origins.as_ref()) {
        (Some(placeholder), _) => out.push(group(&p, [placeholder]).into_any_element()),
        (None, Some(list)) => out.push(grouped_list(
            &p,
            format!("settings:sites:{profile}"),
            &view.scroll,
            list.items.clone(),
            |ix| {
                let origin = &list.rows[ix];
                let emit = view.emit.clone();
                let open = format!("{OPEN}site:{origin}");
                tagged(
                    format!("site:{origin}"),
                    row(format!("site:{origin}"), &p)
                        .icon(site_icon(view, profile, origin, 16.))
                        .title_line(data::site_label(origin))
                        .on_click(move |_, window, cx| emit.send(cmd(open.clone()), window, cx)),
                )
            },
        )),
        (None, None) => {}
    }
    let zooms = view.sub.memo.zooms.get(
        view.host.as_ref(),
        SettingsQuery::Zooms(profile.clone()),
        |value| {
            Listed::new(
                value.as_ref().map(data::zooms_of).unwrap_or_default(),
                |(host, _)| format!("zoom:{host}"),
                |_| DESCRIBED_ROW_ESTIMATE,
            )
        },
    );
    if !zooms.rows.is_empty() {
        out.push(header(&p, "Zoom levels", None, None));
        out.push(grouped_list(
            &p,
            format!("settings:zooms:{profile}"),
            &view.scroll,
            zooms.items.clone(),
            |ix| {
                let (host, level) = &zooms.rows[ix];
                row(format!("zoom:{host}"), &p)
                    .icon(site_icon(view, profile, &format!("https://{host}"), 16.))
                    .title_line(host.clone())
                    .description(data::percent(*level))
                    .child(button(
                        view,
                        format!("zoom-reset:{host}"),
                        "Reset",
                        cmd(format!("{COMMAND}zoomReset:{host}")),
                    ))
                    .into_any_element()
            },
        ));
    }
    div().children(out).into_any_element()
}

fn site_page(view: &SettingsWindowView, profile: &ProfileId, origin: &str) -> AnyElement {
    let p = view.look.p;
    let host = data::site_label(origin);
    let settings = value(
        view,
        SettingsQuery::Site(profile.clone(), origin.to_owned()),
    );
    let shown = settings
        .as_ref()
        .map(data::site_settings_of)
        .unwrap_or_default();
    let block_autoplay = view.state.settings.block_autoplay_everywhere;
    let mut rows: Vec<AnyElement> = Vec::new();
    if settings.is_some() && shown.is_empty() {
        rows.push(
            row("site-nothing", &p)
                .title_line("Nothing to change for this site")
                .into_any_element(),
        );
    }
    for setting in &shown {
        let current = if setting.is_default {
            "default"
        } else {
            setting.value.as_str()
        };
        let label = data::SITE_VALUES
            .iter()
            .find(|(v, _)| *v == current)
            .map_or(current, |(_, label)| label);
        let items = data::SITE_VALUES
            .iter()
            .map(|(v, title)| MenuItem {
                label: SharedString::new_static(title),
                checked: *v == current,
                command: format!("{COMMAND}siteSet:{}:{v}", setting.kind),
            })
            .collect();
        let mut line = row(format!("site-setting:{}", setting.kind), &p).title_line(setting.label);
        if setting.is_default {
            line = line.description(format!(
                "Default ({})",
                data::effective_site_value(setting.kind, &setting.value, block_autoplay)
            ));
        }
        rows.push(
            line.child(menu_popup(
                view,
                format!("siteSetting:{}", setting.kind),
                label.to_owned(),
                100.,
                items,
            ))
            .into_any_element(),
        );
    }
    let zoom = value(view, SettingsQuery::Zooms(profile.clone()))
        .map(|v| data::zooms_of(&v))
        .unwrap_or_default()
        .into_iter()
        .find(|(zoom_host, _)| *zoom_host == host);
    let status = view
        .sub
        .site_status
        .as_ref()
        .filter(|(at, _)| at == origin)
        .map(|(_, text)| text.clone());
    let mut this_site: Vec<AnyElement> = Vec::new();
    if let Some((_, level)) = zoom {
        this_site.push(
            row("site-zoom", &p)
                .title_line("Zoom")
                .description(data::percent(level))
                .child(button(
                    view,
                    "site-zoom-reset",
                    "Reset",
                    cmd(format!("{COMMAND}zoomReset:{host}")),
                ))
                .into_any_element(),
        );
    }
    this_site.push(
        row("site-permissions", &p)
            .title_line("Permissions")
            .description("Puts every permission back to its default.")
            .child(button(
                view,
                "site-reset",
                "Reset Permissions",
                cmd(format!("{COMMAND}siteReset")),
            ))
            .into_any_element(),
    );
    this_site.push(
        row("site-data", &p)
            .title_line("Site data")
            .description(status.unwrap_or_else(|| {
                "Cookies and storage this site keeps in this profile.".to_owned()
            }))
            .child(button(
                view,
                "site-clear",
                "Clear Site Data",
                cmd(format!("{COMMAND}siteClear")),
            ))
            .into_any_element(),
    );
    div()
        .child(first_header(
            &p,
            host,
            None,
            Some(site_icon(view, profile, origin, 20.)),
        ))
        .child(group(&p, rows))
        .child(header(&p, "This site", None, None))
        .child(group(&p, this_site))
        .into_any_element()
}

fn other_engines_page(view: &SettingsWindowView) -> AnyElement {
    let p = view.look.p;
    let settings = &view.state.settings;
    let engines = ardia_state::omnibox::engines::all_engines(
        &settings.custom_search_engines,
        &settings.extension_search_engines,
        "",
    );
    let selected = default_engine_id(view);
    let locked = controlling_extension(view).is_some();
    let custom: Vec<_> = engines.iter().filter(|e| e.custom).collect();
    let from_extensions: Vec<_> = engines.iter().filter(|e| e.extension.is_some()).collect();
    let custom_rows: Vec<AnyElement> = if custom.is_empty() {
        vec![
            row("engines-none", &p)
                .title_line("No custom search engines")
                .description("Add one with a URL where %s stands for the search terms.")
                .into_any_element(),
        ]
    } else {
        custom
            .iter()
            .map(|engine| engine_row(view, engine, &selected, locked, engine.id != "custom"))
            .collect()
    };
    let mut out = vec![
        first_header(
            &p,
            "Other search engines",
            Some(SharedString::new_static(
                "Type a shortcut and press Tab to search a site directly.",
            )),
            Some(
                button(
                    view,
                    "engine-add",
                    "Add…",
                    cmd(format!("{COMMAND}engine:new")),
                )
                .icon(Icon::Plus)
                .into_any_element(),
            ),
        ),
        group(&p, custom_rows).into_any_element(),
    ];
    if !from_extensions.is_empty() {
        out.push(header(
            &p,
            "From extensions",
            Some(SharedString::new_static(
                "Some extensions can add search engines to Ardia.",
            )),
            None,
        ));
        out.push(
            group(
                &p,
                from_extensions
                    .iter()
                    .map(|engine| engine_row(view, engine, &selected, locked, false)),
            )
            .into_any_element(),
        );
    }
    div().children(out).into_any_element()
}

pub fn controlling_extension(
    view: &SettingsWindowView,
) -> Option<&ardia_state::omnibox::engines::ExtensionSearchEngine> {
    view.state
        .settings
        .extension_search_engines
        .iter()
        .find(|engine| engine.is_default)
}

fn default_engine_id(view: &SettingsWindowView) -> String {
    match controlling_extension(view) {
        Some(engine) => ardia_state::omnibox::engines::extension_engine_id(&engine.extension_id),
        None => view.state.settings.search_engine.clone(),
    }
}

pub fn engine_description(engine: &ardia_state::omnibox::engines::SearchEngine) -> String {
    match &engine.extension {
        Some((_, name)) => format!(
            "{}Added by {}",
            if engine.keyword.is_empty() {
                String::new()
            } else {
                format!("{} · ", engine.keyword)
            },
            if name.is_empty() {
                "an extension"
            } else {
                name
            }
        ),
        None if engine.custom => format!("{} · {}", engine.keyword, engine.url),
        None => engine.keyword.clone(),
    }
}

fn engine_row(
    view: &SettingsWindowView,
    engine: &ardia_state::omnibox::engines::SearchEngine,
    selected: &str,
    locked: bool,
    editable: bool,
) -> AnyElement {
    let p = view.look.p;
    let default_profile = panes::default_profile(view);
    let mut line = row(format!("engine:{}", engine.id), &p)
        .icon(site_icon(
            view,
            &default_profile,
            &format!("https://{}", engine.host()),
            16.,
        ))
        .title_line(engine.name.clone())
        .description(engine_description(engine));
    if editable {
        line = line.child(glyph_button(
            view,
            format!("engine-edit:{}", engine.id),
            Icon::Pencil,
            "Edit",
            cmd(format!("{COMMAND}engine:edit:{}", engine.id)),
        ));
    }
    let trailing = if engine.id == selected {
        div()
            .min_w(px(92.))
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(4.))
            .child(icon(Icon::Check, 11., p.form_accent))
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(p.text_secondary)
                    .child("Default"),
            )
            .into_any_element()
    } else {
        div()
            .min_w(px(92.))
            .child(
                button(
                    view,
                    format!("engine-default:{}", engine.id),
                    "Make Default",
                    panes::set("searchEngine", engine.id.clone()),
                )
                .disabled(locked),
            )
            .into_any_element()
    };
    line.child(trailing).into_any_element()
}

fn extension_icon(ext: &InstalledExtension, side: f32) -> AnyElement {
    extension_image(ext, decoded_icon(ext), side)
}

fn decoded_icon(ext: &InstalledExtension) -> Option<std::sync::Arc<gpui::Image>> {
    ext.icon
        .starts_with("data:")
        .then(|| crate::primitives::favicon::decode_data_uri(&ext.icon))
        .flatten()
}

fn extension_image(
    ext: &InstalledExtension,
    image: Option<std::sync::Arc<gpui::Image>>,
    side: f32,
) -> AnyElement {
    let frame = div().flex_none().size(px(side));
    match image {
        Some(image) => frame
            .child(
                gpui::img(image)
                    .size(px(side))
                    .opacity(if ext.enabled { 1. } else { 0.5 }),
            )
            .into_any_element(),
        None => frame
            .flex()
            .items_center()
            .justify_center()
            .child(icon(
                Icon::PuzzleExtension,
                side * 0.6,
                gpui::hsla(0., 0., 0.5, 1.),
            ))
            .into_any_element(),
    }
}

pub fn extensions_of(
    view: &SettingsWindowView,
    profile: &ProfileId,
) -> Option<Vec<InstalledExtension>> {
    value(view, SettingsQuery::Extensions(profile.clone())).map(|v| data::extensions_of(&v))
}

pub(crate) struct ExtensionRow {
    ext: InstalledExtension,
    icon: Option<std::sync::Arc<gpui::Image>>,
    subtitle: String,
    description: String,
}

pub(crate) fn installed_extensions(
    view: &SettingsWindowView,
    profile: &ProfileId,
) -> std::rc::Rc<Option<Listed<ExtensionRow>>> {
    view.sub.memo.extensions.get(
        view.host.as_ref(),
        SettingsQuery::Extensions(profile.clone()),
        |value| {
            value.as_ref().map(|v| {
                let rows = data::extensions_of(v)
                    .into_iter()
                    .map(|ext| ExtensionRow {
                        icon: decoded_icon(&ext),
                        subtitle: ext.list_subtitle(),
                        description: ext.list_description(),
                        ext,
                    })
                    .collect();
                Listed::new(
                    rows,
                    |row| format!("extension:{}", row.ext.id),
                    |row| {
                        if row.description.is_empty() {
                            ROW_ESTIMATE
                        } else {
                            DESCRIBED_ROW_ESTIMATE
                        }
                    },
                )
            })
        },
    )
}

pub fn installed_extensions_list(view: &SettingsWindowView, profile: &ProfileId) -> AnyElement {
    let p = view.look.p;
    let listed = installed_extensions(view, profile);
    let Some(listed) = listed.as_ref() else {
        return div().into_any_element();
    };
    virtual_list(format!("settings:extensions:{profile}"), &view.scroll)
        .items(listed.items.clone())
        .render(|ix, _| {
            let ExtensionRow {
                ext,
                icon: image,
                subtitle,
                description,
            } = &listed.rows[ix];
            let emit = view.emit.clone();
            let open = format!("{OPEN}extension:{}", ext.id);
            let id = ext.id.clone();
            let title = div()
                .flex()
                .flex_row()
                .min_w_0()
                .overflow_hidden()
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .whitespace_nowrap()
                        .child(ext.name.clone()),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .whitespace_nowrap()
                        .text_color(p.text_tertiary)
                        .child(subtitle.clone()),
                );
            let mut line = row(format!("extension:{}", ext.id), &p)
                .icon(extension_image(ext, image.clone(), 24.))
                .title_element(title);
            if !description.is_empty() {
                line = line.description(description.clone());
            }
            divided(
                &p,
                true,
                tagged(
                    format!("extension:{}", ext.id),
                    line.child(toggle_control(
                        view,
                        format!("toggle:extension:{}", ext.id),
                        ext.enabled,
                        false,
                        move |on| cmd(format!("{COMMAND}ext:enable:{on}:{id}")),
                    ))
                    .on_click(move |_, window, cx| emit.send(cmd(open.clone()), window, cx)),
                ),
            )
        })
}

fn extension_page(view: &SettingsWindowView, profile: &ProfileId, id: &str) -> AnyElement {
    let p = view.look.p;
    let listed = installed_extensions(view, profile);
    let Some(ext) = listed
        .as_ref()
        .as_ref()
        .and_then(|list| list.rows.iter().find(|row| row.ext.id == id))
        .map(|row| row.ext.clone())
    else {
        return div().into_any_element();
    };
    let mut permissions: Vec<AnyElement> = if ext.permissions.is_empty() {
        vec![
            row("ext-no-permissions", &p)
                .title_line("This extension requires no special permissions.")
                .into_any_element(),
        ]
    } else {
        ext.permissions
            .iter()
            .map(|permission| {
                row(format!("ext-permission:{permission}"), &p)
                    .title_line(permission.clone())
                    .into_any_element()
            })
            .collect()
    };
    if ext.site_access.is_some() {
        let choice = ext.site_access_choice();
        let label = data::SITE_ACCESS
            .iter()
            .find(|(v, _)| *v == choice)
            .map_or("", |(_, l)| l);
        let items = data::SITE_ACCESS
            .iter()
            .map(|(v, title)| MenuItem {
                label: SharedString::new_static(title),
                checked: *v == choice,
                command: if *v == "specificSites" {
                    format!("{COMMAND}ext:addSite")
                } else {
                    format!("{COMMAND}ext:access:{v}")
                },
            })
            .collect();
        permissions.push(
            row("ext-site-access", &p)
                .title_line("Site access")
                .description("Which sites the extension can read and change.")
                .child(menu_popup(view, "extSiteAccess".into(), label, 120., items))
                .into_any_element(),
        );
        if choice == "specificSites" {
            for site in &ext.sites {
                let mut line =
                    row(format!("ext-site:{site}"), &p).title_line(data::site_pattern_label(site));
                if let Some((problem_site, problem)) = &view.sub.site_problem
                    && problem_site == site
                {
                    line = line.description(problem.clone());
                }
                permissions.push(
                    line.child(button(
                        view,
                        format!("ext-site-remove:{site}"),
                        "Remove",
                        cmd(format!("{COMMAND}ext:removeSite:{site}")),
                    ))
                    .into_any_element(),
                );
            }
            permissions.push(
                row("ext-site-add", &p)
                    .child(button(
                        view,
                        "ext-site-add-button",
                        "Add Site…",
                        cmd(format!("{COMMAND}ext:addSite")),
                    ))
                    .into_any_element(),
            );
        }
    }
    let ext_id = ext.id.clone();
    let mut settings_rows: Vec<AnyElement> = vec![
        row("ext-pin", &p)
            .title_line("Pin to toolbar")
            .description("Show its button next to the address.")
            .child(toggle_control(
                view,
                "toggle:ext-pin",
                ext.pinned,
                false,
                |on| cmd(format!("{COMMAND}ext:configure:pinned:{on}")),
            ))
            .into_any_element(),
        row("ext-incognito", &p)
            .title_line("Allow in Incognito")
            .description("Incognito can't stop extensions from recording your browsing.")
            .child(toggle_control(
                view,
                "toggle:ext-incognito",
                ext.incognito,
                false,
                |on| cmd(format!("{COMMAND}ext:configure:incognito:{on}")),
            ))
            .into_any_element(),
    ];
    if ext.user_scripts_available {
        settings_rows.push(
            row("ext-user-scripts", &p)
                .title_line("Allow User Scripts")
                .description(
                    "Lets it run unreviewed code, like userscripts. Only for code you trust.",
                )
                .child(toggle_control(
                    view,
                    "toggle:ext-user-scripts",
                    ext.user_scripts,
                    false,
                    |on| cmd(format!("{COMMAND}ext:configure:userScripts:{on}")),
                ))
                .into_any_element(),
        );
    }
    if let Some(url) = &ext.options_url {
        settings_rows.push(
            row("ext-options", &p)
                .title_line("Extension options")
                .child(button(
                    view,
                    "ext-options-open",
                    "Open",
                    panes::open_page_owned(view, url.clone()),
                ))
                .into_any_element(),
        );
    }
    if let Some(url) = &ext.web_store_url {
        settings_rows.push(
            row("ext-store", &p)
                .title_line("View in Chrome Web Store")
                .child(button(
                    view,
                    "ext-store-open",
                    "Open",
                    panes::open_page_owned(view, url.clone()),
                ))
                .into_any_element(),
        );
    }
    if !ext.from_web_store {
        let mut reload = row("ext-reload", &p).title_line("Reload");
        if let Some(path) = &ext.path {
            reload = reload.description(path.clone());
        }
        settings_rows.push(
            reload
                .child(button(
                    view,
                    "ext-reload-button",
                    "Reload",
                    cmd(format!("{COMMAND}ext:reload")),
                ))
                .into_any_element(),
        );
    }
    if !ext.errors.is_empty() {
        settings_rows.push(
            row("ext-errors", &p)
                .title_line("Errors")
                .description(
                    ext.errors
                        .iter()
                        .take(5)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
                .into_any_element(),
        );
    }
    settings_rows.push(
        row("ext-id", &p)
            .title_element(
                div()
                    .text_size(px(13.))
                    .text_color(p.text_tertiary)
                    .child(format!("ID {}", ext.id)),
            )
            .into_any_element(),
    );
    let header_row = row("ext-head", &p)
        .icon(extension_icon(&ext, DETAILS_ICON))
        .title_element(
            div()
                .text_size(px(15.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(ext.name.clone()),
        )
        .description(ext.version_line())
        .child(toggle_control(
            view,
            "toggle:ext-enabled",
            ext.enabled,
            false,
            move |on| cmd(format!("{COMMAND}ext:enable:{on}:{ext_id}")),
        ))
        .into_any_element();
    div()
        .child(group(&p, [header_row]))
        .when(!ext.description.is_empty(), |this| {
            this.child(
                div()
                    .mt(px(14.))
                    .text_size(px(13.))
                    .line_height(px(19.))
                    .text_color(p.text_secondary)
                    .child(ext.description.clone()),
            )
        })
        .child(header(&p, "Permissions", None, None))
        .child(group(&p, permissions))
        .children(crate::settings::extras::pairing_rows(view, &ext.id))
        .child(header(&p, "Settings", None, None))
        .child(group(&p, settings_rows))
        .child(
            div().mt(px(20.)).flex().child(
                button(
                    view,
                    "ext-remove",
                    "Remove Extension…",
                    cmd(format!("{COMMAND}ext:remove")),
                )
                .kind(ButtonKind::Destructive)
                .disabled(!ext.may_modify),
            ),
        )
        .into_any_element()
}

pub fn export_bookmarks_control(view: &SettingsWindowView) -> AnyElement {
    tagged(
        "button:profiles.exportBookmarks".into(),
        button(
            view,
            "button:profiles.exportBookmarks",
            "Export…",
            cmd(EXPORT_BOOKMARKS),
        )
        .disabled(view.sub.bookmarks_busy),
    )
}

fn call(
    view: &mut SettingsWindowView,
    call: SettingsCall,
    cx: &mut Context<SettingsWindowView>,
    then: impl FnOnce(&mut SettingsWindowView, Result<Value, String>, &mut Context<SettingsWindowView>)
    + 'static,
) {
    let reply = view.host.settings_call(call);
    cx.spawn(async move |this, cx| {
        let result = reply
            .await
            .unwrap_or_else(|_| Err("the browser didn't answer".to_owned()));
        let _ = this.update(cx, |view, cx| {
            then(view, result, cx);
            cx.notify();
        });
    })
    .detach();
}

fn fire(
    view: &mut SettingsWindowView,
    settings_call: SettingsCall,
    cx: &mut Context<SettingsWindowView>,
) {
    call(view, settings_call, cx, |_, _, _| {});
}

fn new_field(
    view: &mut SettingsWindowView,
    placeholder: &str,
    text: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) -> Entity<TextInput> {
    let style = text_field_style(&view.look);
    let placeholder = placeholder.to_owned();
    let input = cx.new(|cx| TextInput::new(placeholder, cx));
    let text = text.to_owned();
    input.update(cx, |input, cx| {
        input.set_style(style, cx);
        input.set_text(text, false, cx);
    });
    view.sub.subscriptions.push(cx.subscribe_in(
        &input,
        window,
        |view, _, event: &InputEvent, window, cx| match event {
            InputEvent::Submit(_) => save_sheet(view, window, cx),
            InputEvent::Cancel => close_sheet(view, window, cx),
            InputEvent::Changed { .. } => {
                match view.sub.sheet.as_mut() {
                    Some(Sheet::Card { error, .. })
                    | Some(Sheet::Engine { error, .. })
                    | Some(Sheet::AddSite { error, .. }) => *error = None,
                    _ => {}
                }
                cx.notify();
            }
            _ => {}
        },
    ));
    input
}

pub(crate) fn open_sheet(
    view: &mut SettingsWindowView,
    sheet: Sheet,
    fields: &[(&str, String)],
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    view.sub.fields.clear();
    view.sub.subscriptions.clear();
    let made: Vec<Entity<TextInput>> = fields
        .iter()
        .map(|(placeholder, text)| new_field(view, placeholder, text, window, cx))
        .collect();
    view.sub.fields = made;
    view.sub.sheet = Some(sheet);
    if let Some(first) = view.sub.fields.first().cloned() {
        cx.defer_in(window, move |_, window, cx| focus_input(&first, window, cx));
    }
    cx.notify();
}

pub fn close_sheet(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    view.sub.sheet = None;
    view.sub.fields.clear();
    window.focus(&view.focus, cx);
    cx.notify();
}

pub(crate) fn field_text(
    view: &SettingsWindowView,
    index: usize,
    cx: &Context<SettingsWindowView>,
) -> String {
    view.sub
        .fields
        .get(index)
        .map(|field| field.read(cx).text().to_owned())
        .unwrap_or_default()
}

fn save_sheet(
    view: &mut SettingsWindowView,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    if matches!(view.sub.sheet, Some(Sheet::EngineRule { .. })) {
        crate::settings::engines::save_rule(view, window, cx);
        return;
    }
    let Some(profile) = profile_of(view) else {
        return;
    };
    match view.sub.sheet.clone() {
        Some(Sheet::ExtensionInstall { error: Some(_), .. }) => close_sheet(view, window, cx),
        Some(Sheet::ExtensionInstall {
            path, busy: false, ..
        }) => {
            if let Some(Sheet::ExtensionInstall { busy, .. }) = view.sub.sheet.as_mut() {
                *busy = true;
            }
            call(
                view,
                SettingsCall::InstallUnpackedExtension { profile, path },
                cx,
                |view, result, _| match result {
                    Ok(_) => {
                        view.sub.sheet = None;
                        view.sub.fields.clear();
                    }
                    Err(problem) => {
                        if let Some(Sheet::ExtensionInstall { error, busy, .. }) =
                            view.sub.sheet.as_mut()
                        {
                            *error = Some(problem);
                            *busy = false;
                        }
                    }
                },
            );
            cx.notify();
        }
        Some(Sheet::AddSite { saving: false, .. }) => {
            let typed = field_text(view, 0, cx);
            if typed.trim().is_empty() {
                return;
            }
            let Some(Detail::Extension(id)) = view.sub.detail.clone() else {
                return;
            };
            let Some(site) = ardia_state::extension_rules::extension_site_pattern(&typed) else {
                if let Some(Sheet::AddSite { error, .. }) = view.sub.sheet.as_mut() {
                    *error = Some(ardia_state::extension_rules::INVALID_SITE.to_owned());
                }
                cx.notify();
                return;
            };
            if let Some(Sheet::AddSite { saving, .. }) = view.sub.sheet.as_mut() {
                *saving = true;
            }
            call(
                view,
                SettingsCall::ConfigureExtension {
                    profile,
                    id,
                    options: serde_json::json!({ "siteAccess": "specificSites", "grantSite": site }),
                },
                cx,
                |view, result, _| match result {
                    Ok(_) => {
                        ardia_telemetry::counts::count("extension_sites_added");
                        view.sub.sheet = None;
                        view.sub.fields.clear();
                    }
                    Err(problem) => {
                        ardia_telemetry::counts::count("extension_site_change_failures");
                        if let Some(Sheet::AddSite { error, saving, .. }) = view.sub.sheet.as_mut()
                        {
                            *error = Some(site_change_reason(&problem, GRANT_FAILED));
                            *saving = false;
                        }
                    }
                },
            );
            cx.notify();
        }
        Some(Sheet::Password {
            saved,
            editing: true,
            busy: false,
            ..
        }) => {
            let username = field_text(view, 0, cx);
            let password = field_text(view, 1, cx);
            if password.is_empty() {
                return;
            }
            if let Some(Sheet::Password { busy, error, .. }) = view.sub.sheet.as_mut() {
                *busy = true;
                *error = None;
            }
            let new_username = (username != saved.username).then_some(username);
            call(
                view,
                SettingsCall::UpdatePassword {
                    profile,
                    origin: saved.origin.clone(),
                    username: saved.username,
                    new_username,
                    password: Secret(password),
                },
                cx,
                |view, result, cx| match result {
                    Ok(_) => {
                        view.sub.sheet = None;
                        view.sub.fields.clear();
                        cx.notify();
                    }
                    Err(_) => {
                        if let Some(Sheet::Password { busy, error, .. }) = view.sub.sheet.as_mut() {
                            *busy = false;
                            *error = Some("Couldn't confirm that the change was saved. It may still appear in the list in a moment.".to_owned());
                        }
                    }
                },
            );
        }
        Some(Sheet::Address { saved }) => {
            let values: Vec<String> = (0..data::ADDRESS_FIELDS.len())
                .map(|index| field_text(view, index, cx))
                .collect();
            if values.iter().all(|v| v.trim().is_empty()) {
                return;
            }
            let address = data::address_input(saved.as_ref().map(|s| s.id.as_str()), &values);
            fire(view, SettingsCall::SaveAddress { profile, address }, cx);
            close_sheet(view, window, cx);
        }
        Some(Sheet::Card {
            saved,
            number_shown,
            month,
            year,
            ..
        }) => {
            let number_field = saved.is_none() || number_shown;
            let digits: String = if number_field {
                field_text(view, 0, cx)
                    .chars()
                    .filter(char::is_ascii_digit)
                    .collect()
            } else {
                String::new()
            };
            if number_field && digits.len() < 12 {
                return;
            }
            let name_index = if number_field { 1 } else { 0 };
            let name = field_text(view, name_index, cx);
            let card = data::card_input(saved.as_ref().map(|s| s.id.as_str()), &name, month, year);
            let number = number_field.then_some(Secret(digits));
            call(
                view,
                SettingsCall::SaveCard {
                    profile,
                    card,
                    number,
                },
                cx,
                |view, result, cx| {
                    let saved = result
                        .ok()
                        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
                        .is_some_and(|id| !id.is_empty());
                    if saved {
                        view.sub.sheet = None;
                        view.sub.fields.clear();
                    } else if let Some(Sheet::Card { error, .. }) = view.sub.sheet.as_mut() {
                        *error = Some("That isn't a valid card number.".to_owned());
                    }
                    cx.notify();
                },
            );
        }
        Some(Sheet::Engine { id, .. }) => {
            let name = field_text(view, 0, cx);
            let keyword = field_text(view, 1, cx);
            let url = field_text(view, 2, cx);
            match engine_patch(view, id.as_deref(), &name, &keyword, &url) {
                Ok(patch) => {
                    view.host.dispatch(Action::UpdateSettings {
                        patch,
                        from_sync: false,
                    });
                    close_sheet(view, window, cx);
                }
                Err(message) => {
                    if let Some(Sheet::Engine { error, .. }) = view.sub.sheet.as_mut() {
                        *error = Some(message);
                    }
                    cx.notify();
                }
            }
        }
        _ => {}
    }
}

pub fn new_engine_id(now_ms: u64, counter: u64) -> String {
    format!("engine-{}-{}", radix36(now_ms), radix36(counter))
}

fn radix36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

static ENGINE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn engine_patch(
    view: &SettingsWindowView,
    id: Option<&str>,
    name: &str,
    keyword: &str,
    url: &str,
) -> Result<ardia_state::settings::SettingsPatch, String> {
    engine_patch_for(&view.state.settings, id, name, keyword, url)
}

pub fn engine_patch_for(
    settings: &ardia_state::settings::Settings,
    id: Option<&str>,
    name: &str,
    keyword: &str,
    url: &str,
) -> Result<ardia_state::settings::SettingsPatch, String> {
    use ardia_state::omnibox::engines::{all_engines, validate_engine};
    let mut list = settings.custom_search_engines.clone();
    if let Some(id) = id
        && !list.iter().any(|e| e.id == id)
    {
        return Err("This search engine no longer exists.".to_owned());
    }
    let engines = all_engines(&list, &settings.extension_search_engines, "");
    let mut engine = validate_engine(name, keyword, url, &engines, id)?;
    match id {
        Some(id) => {
            engine.id = id.to_owned();
            for existing in list.iter_mut() {
                if existing.id == id {
                    *existing = engine.clone();
                }
            }
        }
        None => {
            let counter = ENGINE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            engine.id = new_engine_id(ardia_state::store::now_ms() as u64, counter);
            list.push(engine);
        }
    }
    Ok(ardia_state::settings::SettingsPatch::new().set(
        "customSearchEngines",
        serde_json::to_value(&list).unwrap_or(Value::Array(Vec::new())),
    ))
}

pub fn remove_engine_patch(
    settings: &ardia_state::settings::Settings,
    id: &str,
) -> ardia_state::settings::SettingsPatch {
    let list: Vec<_> = settings
        .custom_search_engines
        .iter()
        .filter(|e| e.id != id)
        .cloned()
        .collect();
    let mut patch = ardia_state::settings::SettingsPatch::new().set(
        "customSearchEngines",
        serde_json::to_value(&list).unwrap_or(Value::Array(Vec::new())),
    );
    if settings.search_engine == id {
        patch = patch.set(
            "searchEngine",
            ardia_state::settings::Settings::default().search_engine,
        );
    }
    patch
}

pub(crate) struct PasswordRow {
    saved: SavedPassword,
    origin_lower: String,
    username_lower: String,
}

impl PasswordRow {
    fn new(saved: SavedPassword) -> Self {
        PasswordRow {
            origin_lower: saved.origin.to_lowercase(),
            username_lower: saved.username.to_lowercase(),
            saved,
        }
    }

    fn matches(&self, wanted: &str) -> bool {
        wanted.is_empty()
            || self.origin_lower.contains(wanted)
            || self.username_lower.contains(wanted)
    }
}

fn passwords_list(view: &SettingsWindowView, profile: &ProfileId) -> Vec<SavedPassword> {
    value(view, SettingsQuery::Passwords(profile.clone()))
        .map(|v| data::passwords_of(&v))
        .unwrap_or_default()
}

fn reveal_password(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    let (Some(profile), Some(Sheet::Password { saved, .. })) =
        (profile_of(view), view.sub.sheet.clone())
    else {
        return;
    };
    call(
        view,
        SettingsCall::RevealPassword {
            profile,
            origin: saved.origin.clone(),
            username: saved.username.clone(),
        },
        cx,
        move |view, result, _| {
            let secret = result
                .ok()
                .and_then(|v| v.get("password").and_then(Value::as_str).map(str::to_owned));
            if let Some(Sheet::Password {
                saved: open,
                revealed,
                ..
            }) = view.sub.sheet.as_mut()
                && *open == saved
            {
                *revealed = secret;
            }
        },
    );
}

pub fn run(
    view: &mut SettingsWindowView,
    id: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(rest) = id.strip_prefix(COMMAND) else {
        return;
    };
    if let Some(key) = rest.strip_prefix("open:") {
        if let Some(detail) = Detail::parse(key) {
            open_detail(view, Some(detail), window, cx);
        }
        return;
    }
    if rest == "exportBookmarks" {
        let Some(profile) = profile_of(view) else {
            return;
        };
        view.sub.bookmarks_busy = true;
        view.sub.bookmarks_status = None;
        call(
            view,
            SettingsCall::ExportBookmarks(profile),
            cx,
            |view, result, _| {
                view.sub.bookmarks_busy = false;
                view.sub.bookmarks_status = match result {
                    Ok(reply) => data::bookmarks_export_status(&reply),
                    Err(problem) => Some(format!("Couldn't export: {problem}")),
                };
            },
        );
        cx.notify();
        return;
    }
    if rest == "sheetClose" {
        close_sheet(view, window, cx);
        return;
    }
    if crate::settings::engines::run(view, rest, window, cx) {
        return;
    }
    if crate::settings::general_subpages::run(view, rest, window, cx) {
        cx.notify();
        return;
    }
    if rest == "sheetSave" {
        save_sheet(view, window, cx);
        return;
    }
    let Some(profile) = profile_of(view) else {
        return;
    };
    match rest {
        "unlock" => fire(view, SettingsCall::UnlockPasswords(profile), cx),
        "importPasswords" => {
            call(
                view,
                SettingsCall::ImportPasswords(profile),
                cx,
                |view, result, _| match result {
                    Ok(reply) => {
                        if let Some(status) = data::import_status(&reply) {
                            view.sub.import_status = Some(status);
                        }
                    }
                    Err(problem) => {
                        view.sub.import_status =
                            Some(format!("Couldn't import that file: {problem}"));
                    }
                },
            );
        }
        "exportPasswords" => {
            call(
                view,
                SettingsCall::ExportPasswords(profile),
                cx,
                |view, result, _| {
                    let status = match result {
                        Ok(reply) => data::export_status(&reply),
                        Err(_) => {
                            data::export_status(&serde_json::json!({"status": "writeFailed"}))
                        }
                    };
                    view.sub.export_status = (!status.is_empty()).then_some(status);
                },
            );
        }
        "pwReveal" => {
            if let Some(Sheet::Password { shown, .. }) = view.sub.sheet.as_mut() {
                *shown = !*shown;
                let secure = !*shown;
                if let Some(field) = view.sub.fields.get(1).cloned() {
                    field.update(cx, |input, cx| input.set_secure(secure, cx));
                }
            }
            cx.notify();
        }
        "pwCopyUser" => {
            if let Some(Sheet::Password { saved, .. }) = &view.sub.sheet {
                cx.write_to_clipboard(ClipboardItem::new_string(saved.username.clone()));
            }
        }
        "pwCopy" => {
            if let Some(Sheet::Password {
                revealed: Some(secret),
                ..
            }) = &view.sub.sheet
            {
                cx.write_to_clipboard(ClipboardItem::new_string(secret.clone()));
            }
        }
        "pwEdit" => {
            if let Some(Sheet::Password {
                saved,
                revealed,
                shown,
                ..
            }) = view.sub.sheet.clone()
            {
                let fields = [
                    ("", saved.username.clone()),
                    ("", revealed.clone().unwrap_or_default()),
                ];
                open_sheet(
                    view,
                    Sheet::Password {
                        saved,
                        revealed,
                        shown,
                        editing: true,
                        busy: false,
                        error: None,
                    },
                    &fields,
                    window,
                    cx,
                );
                if let Some(field) = view.sub.fields.get(1).cloned() {
                    field.update(cx, |input, cx| input.set_secure(!shown, cx));
                }
            }
        }
        "pwCancelEdit" => {
            if let Some(Sheet::Password { editing, error, .. }) = view.sub.sheet.as_mut() {
                *editing = false;
                *error = None;
            }
            view.sub.fields.clear();
            cx.notify();
        }
        "pwDelete" => {
            let Some(Sheet::Password { saved, .. }) = view.sub.sheet.clone() else {
                return;
            };
            ask_delete(
                view,
                format!(
                    "Delete the password for {}?",
                    data::host_label(&saved.origin)
                ),
                "You won't be able to sign in with it automatically any more.",
                SettingsCall::RemovePassword {
                    profile,
                    origin: saved.origin,
                    username: saved.username,
                },
                cx,
            );
        }
        "autofillDelete" => match view.sub.sheet.clone() {
            Some(Sheet::Address { saved: Some(saved) }) => ask_delete(
                view,
                "Delete this address?".to_owned(),
                "It won't be offered in forms any more.",
                SettingsCall::RemoveAutofill {
                    profile,
                    id: saved.id,
                },
                cx,
            ),
            Some(Sheet::Card {
                saved: Some(saved), ..
            }) => ask_delete(
                view,
                "Delete this card?".to_owned(),
                "Its number is removed from your Keychain too.",
                SettingsCall::RemoveAutofill {
                    profile,
                    id: saved.id,
                },
                cx,
            ),
            _ => {}
        },
        "cardReveal" => {
            let Some(Sheet::Card {
                saved: Some(saved), ..
            }) = view.sub.sheet.clone()
            else {
                return;
            };
            let _ = profile;
            reveal_card(view, saved, window, cx);
        }
        "cardCopy" => {
            let digits: String = field_text(view, 0, cx)
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            cx.write_to_clipboard(ClipboardItem::new_string(digits));
        }
        "siteReset" => {
            if let Some(Detail::Site(origin)) = view.sub.detail.clone() {
                fire(view, SettingsCall::ResetSite { profile, origin }, cx);
            }
        }
        "siteClear" => {
            if let Some(Detail::Site(origin)) = view.sub.detail.clone() {
                let at = origin.clone();
                call(
                    view,
                    SettingsCall::ClearSiteData { profile, origin },
                    cx,
                    move |view, result, _| {
                        let reply =
                            result.unwrap_or_else(|_| serde_json::json!({"cookies": false}));
                        view.sub.site_status = Some((at, data::cleared_status(&reply)));
                    },
                );
            }
        }
        "ext:reload" | "ext:remove" => {
            let Some(Detail::Extension(id)) = view.sub.detail.clone() else {
                return;
            };
            if rest == "ext:reload" {
                fire(view, SettingsCall::ReloadExtension { profile, id }, cx);
            } else {
                let name = extensions_of(view, &profile)
                    .and_then(|list| list.into_iter().find(|e| e.id == id))
                    .map(|e| e.name)
                    .unwrap_or_default();
                let question = crate::host::Confirmation {
                    title: format!("Remove “{name}”?"),
                    message: String::new(),
                    confirm: "Remove".to_owned(),
                    destructive: true,
                };
                confirm_then(
                    view,
                    question,
                    SettingsCall::UninstallExtension { profile, id },
                    cx,
                );
            }
        }
        other => run_parameterised(view, other, profile, window, cx),
    }
    cx.notify();
}

fn run_parameterised(
    view: &mut SettingsWindowView,
    rest: &str,
    profile: ProfileId,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    if let Some(index) = rest.strip_prefix("password:") {
        let Some(saved) = index
            .parse::<usize>()
            .ok()
            .and_then(|index| passwords_list(view, &profile).get(index).cloned())
        else {
            return;
        };
        view.sub.fields.clear();
        view.sub.sheet = Some(Sheet::Password {
            saved,
            revealed: None,
            shown: false,
            editing: false,
            busy: false,
            error: None,
        });
        reveal_password(view, cx);
    } else if let Some(origin) = rest.strip_prefix("allowSaving:") {
        fire(
            view,
            SettingsCall::AllowSaving {
                profile,
                origin: origin.to_owned(),
            },
            cx,
        );
    } else if let Some(id) = rest.strip_prefix("address:") {
        let saved = (id != "new")
            .then(|| {
                value(view, SettingsQuery::Addresses(profile.clone()))
                    .map(|v| data::addresses_of(&v))
                    .unwrap_or_default()
                    .into_iter()
                    .find(|a| a.id == id)
            })
            .flatten();
        let values = saved.clone().unwrap_or_default().field_values();
        let fields: Vec<(&str, String)> = values.into_iter().map(|text| ("", text)).collect();
        open_sheet(view, Sheet::Address { saved }, &fields, window, cx);
    } else if let Some(id) = rest.strip_prefix("card:") {
        let saved = (id != "new")
            .then(|| {
                value(view, SettingsQuery::Cards(profile.clone()))
                    .map(|v| data::cards_of(&v))
                    .unwrap_or_default()
                    .into_iter()
                    .find(|c| c.id == id)
            })
            .flatten();
        let (month, year) = saved
            .as_ref()
            .map_or((None, None), |card| (card.exp_month, card.exp_year));
        let mut fields: Vec<(&str, String)> = Vec::new();
        if saved.is_none() {
            fields.push(("1234 5678 9012 3456", String::new()));
        }
        fields.push((
            "",
            saved.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
        ));
        open_sheet(
            view,
            Sheet::Card {
                saved,
                number_shown: false,
                month,
                year,
                error: None,
            },
            &fields,
            window,
            cx,
        );
    } else if let Some(month) = rest.strip_prefix("cardMonth:") {
        if let Some(Sheet::Card { month: chosen, .. }) = view.sub.sheet.as_mut() {
            *chosen = month.parse().ok().filter(|m| (1..=12).contains(m));
        }
    } else if let Some(year) = rest.strip_prefix("cardYear:") {
        if let Some(Sheet::Card { year: chosen, .. }) = view.sub.sheet.as_mut() {
            *chosen = year.parse().ok().filter(|y: &i32| *y > 0);
        }
    } else if let Some(rest) = rest.strip_prefix("siteSet:") {
        if let (Some(Detail::Site(origin)), Some((kind, value))) =
            (view.sub.detail.clone(), rest.split_once(':'))
        {
            fire(
                view,
                SettingsCall::SetSiteSetting {
                    profile,
                    origin,
                    kind: kind.to_owned(),
                    value: value.to_owned(),
                },
                cx,
            );
        }
    } else if let Some(host) = rest.strip_prefix("zoomReset:") {
        fire(
            view,
            SettingsCall::SetZoom {
                profile,
                host: host.to_owned(),
                level: 1.0,
            },
            cx,
        );
    } else if let Some(rest) = rest.strip_prefix("engine:") {
        run_engine(view, rest, window, cx);
    } else if let Some(rest) = rest.strip_prefix("ext:enable:") {
        if let Some((on, id)) = rest.split_once(':') {
            fire(
                view,
                SettingsCall::SetExtensionEnabled {
                    profile,
                    id: id.to_owned(),
                    enabled: on == "true",
                },
                cx,
            );
        }
    } else if let Some(rest) = rest.strip_prefix("ext:configure:") {
        if let (Some(Detail::Extension(id)), Some((key, on))) =
            (view.sub.detail.clone(), rest.split_once(':'))
        {
            let mut options = serde_json::Map::new();
            options.insert(key.to_owned(), Value::Bool(on == "true"));
            fire(
                view,
                SettingsCall::ConfigureExtension {
                    profile,
                    id,
                    options: Value::Object(options),
                },
                cx,
            );
        }
    } else if let Some(choice) = rest.strip_prefix("ext:access:") {
        if let Some(Detail::Extension(id)) = view.sub.detail.clone() {
            fire(
                view,
                SettingsCall::ConfigureExtension {
                    profile,
                    id,
                    options: serde_json::json!({ "siteAccess": choice }),
                },
                cx,
            );
        }
    } else if let Some(site) = rest.strip_prefix("ext:removeSite:")
        && let Some(Detail::Extension(id)) = view.sub.detail.clone()
    {
        view.sub.site_problem = None;
        let site = site.to_owned();
        call(
            view,
            SettingsCall::ConfigureExtension {
                profile,
                id,
                options: serde_json::json!({ "revokeSite": site.clone() }),
            },
            cx,
            move |view, result, _| match result {
                Ok(_) => ardia_telemetry::counts::count("extension_sites_removed"),
                Err(problem) => {
                    ardia_telemetry::counts::count("extension_site_change_failures");
                    view.sub.site_problem =
                        Some((site, site_change_reason(&problem, REVOKE_FAILED)));
                }
            },
        );
    } else if rest == "ext:addSite"
        && let Some(Detail::Extension(id)) = view.sub.detail.clone()
    {
        let name = extensions_of(view, &profile)
            .unwrap_or_default()
            .into_iter()
            .find(|ext| ext.id == id)
            .map(|ext| ext.name)
            .unwrap_or_default();
        open_sheet(
            view,
            Sheet::AddSite {
                name,
                error: None,
                saving: false,
            },
            &[("example.com", String::new())],
            window,
            cx,
        );
    } else if rest == "ext:more" {
        open_more_menu(view, profile, window, cx);
    }
}

pub const GRANT_FAILED: &str = "Ardia couldn't give the extension access to that site.";
pub const REVOKE_FAILED: &str = "Ardia couldn't take that site away from the extension.";

pub fn site_change_reason(problem: &str, fallback: &str) -> String {
    let trimmed = problem.trim();
    if trimmed.is_empty() {
        return fallback.to_owned();
    }
    format!("{}.", trimmed.strip_suffix('.').unwrap_or(trimmed))
}

pub fn extensions_header(view: &SettingsWindowView, title: &'static str) -> AnyElement {
    let more = div()
        .debug_selector(|| "extensions-more".into())
        .child(glyph_button(
            view,
            "extensions-more",
            Icon::Ellipsis,
            "More",
            cmd(format!("{COMMAND}ext:more")),
        ))
        .into_any_element();
    header(&view.look.p, title, None, Some(more))
}

pub fn more_menu_items() -> Vec<crate::host::NativeMenuItem> {
    vec![
        crate::host::NativeMenuItem::new("link", "Add from a Link…", "link"),
        crate::host::NativeMenuItem::new("unpacked", "Load Unpacked Extension…", "folder"),
    ]
}

fn open_more_menu(
    view: &mut SettingsWindowView,
    profile: ProfileId,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(choice) = view.host.show_menu(more_menu_items()) else {
        return;
    };
    cx.spawn_in(window, async move |this, cx| {
        let Ok(Some(choice)) = choice.await else {
            return;
        };
        let _ = this.update_in(cx, |view, window, cx| {
            pick_more(view, profile, &choice, window, cx);
        });
    })
    .detach();
}

pub fn pick_more(
    view: &mut SettingsWindowView,
    profile: ProfileId,
    choice: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let settings_call = match choice {
        "link" => SettingsCall::AddExtensionFromLink(profile),
        "unpacked" => SettingsCall::ChooseUnpackedExtension(profile),
        _ => return,
    };
    let reply = view.host.settings_call(settings_call);
    cx.spawn_in(window, async move |this, cx| {
        let result = reply
            .await
            .unwrap_or_else(|_| Err("the browser didn't answer".to_owned()));
        let _ = this.update_in(cx, |view, window, cx| {
            if let Some(sheet) = install_sheet_for(&result) {
                open_sheet(view, sheet, &[], window, cx);
            }
        });
    })
    .detach();
}

pub fn install_sheet_for(result: &Result<Value, String>) -> Option<Sheet> {
    let failed = |error: String| Sheet::ExtensionInstall {
        name: String::new(),
        icon: None,
        warnings: Vec::new(),
        path: String::new(),
        error: Some(error),
        busy: false,
    };
    match result {
        Err(problem) => Some(failed(problem.clone())),
        Ok(info) => {
            if let Some(error) = info.get("error").and_then(Value::as_str) {
                return Some(failed(error.to_owned()));
            }
            let path = info.get("path").and_then(Value::as_str)?.to_owned();
            let text = |key: &str| info.get(key).and_then(Value::as_str).map(str::to_owned);
            Some(Sheet::ExtensionInstall {
                name: text("name")
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "Extension".into()),
                icon: text("icon"),
                warnings: info
                    .get("warnings")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
                path,
                error: None,
                busy: false,
            })
        }
    }
}

fn run_engine(
    view: &mut SettingsWindowView,
    rest: &str,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    if rest == "new" {
        open_sheet(
            view,
            Sheet::Engine {
                id: None,
                error: None,
            },
            &[
                ("Wikipedia", String::new()),
                ("w", String::new()),
                (
                    "https://en.wikipedia.org/w/index.php?search=%s",
                    String::new(),
                ),
            ],
            window,
            cx,
        );
    } else if let Some(id) = rest.strip_prefix("edit:") {
        let Some(engine) = view
            .state
            .settings
            .custom_search_engines
            .iter()
            .find(|e| e.id == id)
            .cloned()
        else {
            return;
        };
        open_sheet(
            view,
            Sheet::Engine {
                id: Some(engine.id.clone()),
                error: None,
            },
            &[
                ("Wikipedia", engine.name),
                ("w", engine.keyword),
                ("https://en.wikipedia.org/w/index.php?search=%s", engine.url),
            ],
            window,
            cx,
        );
    } else if rest == "delete"
        && let Some(Sheet::Engine { id: Some(id), .. }) = view.sub.sheet.clone()
    {
        {
            let patch = remove_engine_patch(&view.state.settings, &id);
            view.host.dispatch(Action::UpdateSettings {
                patch,
                from_sync: false,
            });
            close_sheet(view, window, cx);
        }
    }
}

fn reveal_card(
    view: &mut SettingsWindowView,
    saved: SavedCard,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(profile) = profile_of(view) else {
        return;
    };
    let reply = view.host.settings_call(SettingsCall::CardNumber {
        profile,
        id: saved.id.clone(),
    });
    let window_handle = window.window_handle();
    cx.spawn(async move |this, cx| {
        let number = reply
            .await
            .ok()
            .and_then(Result::ok)
            .and_then(|v| v.get("number").and_then(Value::as_str).map(str::to_owned))
            .filter(|n| !n.is_empty());
        let Some(number) = number else {
            return;
        };
        let _ = cx.update_window(window_handle, |_, window, cx| {
            let _ = this.update(cx, |view, cx| {
                let Some(Sheet::Card {
                    saved: Some(open),
                    month,
                    year,
                    ..
                }) = view.sub.sheet.clone()
                else {
                    return;
                };
                if open.id != saved.id {
                    return;
                }
                let name = field_text(view, 0, cx);
                open_sheet(
                    view,
                    Sheet::Card {
                        saved: Some(open),
                        number_shown: true,
                        month,
                        year,
                        error: None,
                    },
                    &[
                        ("1234 5678 9012 3456", data::format_card_number(&number)),
                        ("", name),
                    ],
                    window,
                    cx,
                );
            });
        });
    })
    .detach();
}

fn ask_delete(
    view: &mut SettingsWindowView,
    title: String,
    message: &str,
    settings_call: SettingsCall,
    cx: &mut Context<SettingsWindowView>,
) {
    let question = crate::host::Confirmation {
        title,
        message: message.to_owned(),
        confirm: "Delete".to_owned(),
        destructive: true,
    };
    confirm_then(view, question, settings_call, cx);
}

fn confirm_then(
    view: &mut SettingsWindowView,
    question: crate::host::Confirmation,
    settings_call: SettingsCall,
    cx: &mut Context<SettingsWindowView>,
) {
    let Some(window) = view.state.main_window_for(None).cloned() else {
        return;
    };
    let answer = view.host.confirm_in_window(window, question);
    let host = view.host.clone();
    cx.spawn(async move |this, cx| {
        if !answer.await.unwrap_or(false) {
            return;
        }
        let deleted = matches!(settings_call, SettingsCall::UninstallExtension { .. });
        let reply = host.settings_call(settings_call);
        let _ = reply.await;
        let _ = this.update(cx, |view, cx| {
            view.sub.sheet = None;
            view.sub.fields.clear();
            if deleted {
                view.leave_detail(cx);
            }
            cx.notify();
        });
    })
    .detach();
}

fn sheet_field(p: &Palette, input: Option<&Entity<TextInput>>, width: f32) -> AnyElement {
    match input {
        Some(input) => field_box(p)
            .w(px(width))
            .h(px(22.))
            .child(div().flex_1().min_w_0().child(input.clone()))
            .into_any_element(),
        None => div().into_any_element(),
    }
}

fn sheet_row(p: &Palette, id: String, title: &str, control: AnyElement) -> AnyElement {
    row(id, p)
        .title_line(title.to_owned())
        .child(control)
        .into_any_element()
}

pub fn sheet(view: &SettingsWindowView, cx: &gpui::App) -> Option<AnyElement> {
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    let sheet = view.sub.sheet.clone()?;
    let p = view.look.p;
    let profile = profile_of(view)?;
    let close = view.emit.clone();
    let dismiss = move |window: &mut Window, cx: &mut gpui::App| {
        close.send(cmd(format!("{COMMAND}sheetClose")), window, cx)
    };
    let fields = view.sub.fields.clone();
    let save = |label: &'static str, disabled: bool| {
        div()
            .debug_selector(move || "sub-sheet-save".into())
            .child(
                button(
                    view,
                    "sub-sheet-save",
                    label,
                    cmd(format!("{COMMAND}sheetSave")),
                )
                .kind(ButtonKind::Primary)
                .disabled(disabled),
            )
            .into_any_element()
    };
    let cancel = button(
        view,
        "sub-sheet-cancel",
        "Cancel",
        cmd(format!("{COMMAND}sheetClose")),
    )
    .into_any_element();
    let element = match sheet {
        Sheet::ResetId { done } => crate::settings::general_subpages::reset_sheet(view, done),
        Sheet::ExtensionInstall {
            name,
            icon,
            warnings,
            path,
            error,
            busy,
        } => install_dialog(view, &name, icon, &warnings, &path, error, busy),
        Sheet::AddSite {
            name,
            error,
            saving,
        } => {
            let empty = fields
                .first()
                .is_none_or(|field| field.read(cx).text().trim().is_empty());
            let cancel_site = button(
                view,
                "site-sheet-cancel",
                "Cancel",
                cmd(format!("{COMMAND}sheetClose")),
            )
            .disabled(saving)
            .into_any_element();
            Dialog::sheet("add-site-sheet", SheetSize::M, &p)
                .on_dismiss(dismiss)
                .child(dialog_title(
                    "Add Site",
                    Some(SharedString::from(format!(
                        "{name} reads and changes only the sites you add."
                    ))),
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
                    field_box(&p)
                        .debug_selector(|| "add-site-field".into())
                        .h(px(22.))
                        .child(div().flex_1().min_w_0().children(fields.first().cloned())),
                )
                .when_some(error, |this, error| {
                    this.child(
                        div()
                            .debug_selector(|| "add-site-error".into())
                            .mt(px(10.))
                            .text_size(px(11.))
                            .text_color(p.destructive)
                            .child(error),
                    )
                })
                .child(dialog_actions(
                    None,
                    None,
                    [cancel_site, save("Add", saving || empty)],
                    &p,
                ))
                .into_any_element()
        }
        Sheet::EngineRule {
            site,
            engine,
            error,
        } => crate::settings::engines::rule_sheet(view, site.as_deref(), engine, error),
        Sheet::EnginesDiffer => crate::settings::engines::differ_sheet(view),
        Sheet::WebKitLimits => crate::settings::engines::limits_sheet(view),
        Sheet::Password {
            saved,
            revealed,
            shown,
            editing,
            busy,
            error,
        } => {
            let username = if editing {
                sheet_field(&p, fields.first(), 220.)
            } else {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .child(div().text_size(px(13.)).child(saved.username.clone()))
                    .child(glyph_button(
                        view,
                        "pw-copy-user",
                        Icon::Copy,
                        "Copy Username",
                        cmd(format!("{COMMAND}pwCopyUser")),
                    ))
                    .into_any_element()
            };
            let password = if editing {
                sheet_field(&p, fields.get(1), 220.)
            } else {
                let text = match &revealed {
                    None => "…".to_owned(),
                    Some(secret) if shown => secret.clone(),
                    Some(secret) => "•".repeat(secret.chars().count().min(12)),
                };
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div()
                            .debug_selector(|| "pw-shown".into())
                            .text_size(px(13.))
                            .when(shown, |this| this.font_family("Menlo"))
                            .child(text),
                    )
                    .child(glyph_button(
                        view,
                        "pw-reveal",
                        if shown { Icon::EyeSlash } else { Icon::Eye },
                        if shown { "Hide" } else { "Show" },
                        cmd(format!("{COMMAND}pwReveal")),
                    ))
                    .child(glyph_button(
                        view,
                        "pw-copy",
                        Icon::Copy,
                        "Copy Password",
                        cmd(format!("{COMMAND}pwCopy")),
                    ))
                    .into_any_element()
            };
            let delete = button(
                view,
                "pw-delete",
                "Delete",
                cmd(format!("{COMMAND}pwDelete")),
            )
            .kind(ButtonKind::Destructive)
            .disabled(busy)
            .into_any_element();
            let buttons = if editing {
                let typed = fields.get(1).is_some_and(|f| !f.read(cx).text().is_empty());
                vec![
                    button(
                        view,
                        "pw-cancel-edit",
                        "Cancel",
                        cmd(format!("{COMMAND}pwCancelEdit")),
                    )
                    .disabled(busy)
                    .into_any_element(),
                    save("Save", !typed || busy),
                ]
            } else {
                vec![
                    button(view, "pw-edit", "Edit", cmd(format!("{COMMAND}pwEdit")))
                        .into_any_element(),
                    button(view, "pw-done", "Done", cmd(format!("{COMMAND}sheetClose")))
                        .kind(ButtonKind::Primary)
                        .into_any_element(),
                ]
            };
            Dialog::sheet("password-sheet", SheetSize::M, &p)
                .on_dismiss(dismiss)
                .child(dialog_title(
                    data::host_label(&saved.origin),
                    None,
                    Some(site_icon(view, &profile, &saved.origin, 20.)),
                    &p,
                ))
                .child(
                    div().mt(px(20.)).child(group(
                        &p,
                        [
                            row("pw-website", &p)
                                .title_line("Website")
                                .description(saved.origin.clone())
                                .into_any_element(),
                            sheet_row(&p, "pw-username".into(), "Username", username),
                            sheet_row(&p, "pw-password".into(), "Password", password),
                        ],
                    )),
                )
                .when_some(error, |this, error| {
                    this.child(
                        div()
                            .mt(px(10.))
                            .text_size(px(11.))
                            .text_color(p.destructive)
                            .child(error),
                    )
                })
                .child(dialog_actions(Some(delete), None, buttons, &p))
                .into_any_element()
        }
        Sheet::Address { saved } => {
            let empty = fields.iter().all(|f| f.read(cx).text().trim().is_empty());
            let rows: Vec<AnyElement> = data::ADDRESS_FIELDS
                .iter()
                .enumerate()
                .map(|(index, (key, title))| {
                    sheet_row(
                        &p,
                        format!("address-field:{key}"),
                        title,
                        sheet_field(&p, fields.get(index), FIELD_WIDTH),
                    )
                })
                .collect();
            let delete = saved.as_ref().map(|_| {
                button(
                    view,
                    "autofill-delete",
                    "Delete",
                    cmd(format!("{COMMAND}autofillDelete")),
                )
                .kind(ButtonKind::Destructive)
                .into_any_element()
            });
            Dialog::sheet("address-sheet", SheetSize::L, &p)
                .on_dismiss(dismiss)
                .child(dialog_title(
                    if saved.is_some() {
                        "Edit Address"
                    } else {
                        "Add Address"
                    },
                    None,
                    None,
                    &p,
                ))
                .child(div().mt(px(20.)).child(group(&p, rows)))
                .child(dialog_actions(
                    delete,
                    None,
                    [cancel, save("Save", empty)],
                    &p,
                ))
                .into_any_element()
        }
        Sheet::Card {
            saved,
            number_shown,
            month,
            year,
            error,
        } => {
            let number_field = saved.is_none() || number_shown;
            let number = if number_field {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .child(sheet_field(
                        &p,
                        fields.first(),
                        if saved.is_some() {
                            FIELD_WIDTH - 28.
                        } else {
                            FIELD_WIDTH
                        },
                    ))
                    .when(saved.is_some(), |this| {
                        this.child(glyph_button(
                            view,
                            "card-copy",
                            Icon::Copy,
                            "Copy Card Number",
                            cmd(format!("{COMMAND}cardCopy")),
                        ))
                    })
                    .into_any_element()
            } else {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .child(div().text_size(px(13.)).child(format!(
                        "•••• •••• •••• {}",
                        saved.as_ref().map(|c| c.last4.clone()).unwrap_or_default()
                    )))
                    .child(glyph_button(
                        view,
                        "card-reveal",
                        Icon::Eye,
                        "Show Card Number",
                        cmd(format!("{COMMAND}cardReveal")),
                    ))
                    .into_any_element()
            };
            let name_index = if number_field { 1 } else { 0 };
            let digits = if number_field {
                fields.first().map_or(0, |f| {
                    f.read(cx)
                        .text()
                        .chars()
                        .filter(char::is_ascii_digit)
                        .count()
                })
            } else {
                12
            };
            let (now_year, _) = now_year_month();
            let mut years: Vec<i32> = (0..16).map(|i| now_year + i).collect();
            if let Some(current) = saved.as_ref().and_then(|c| c.exp_year)
                && !years.contains(&current)
            {
                years.insert(0, current);
            }
            let month_items = std::iter::once((String::new(), "Month".to_owned()))
                .chain((1..=12).map(|m| (m.to_string(), format!("{m:02}"))))
                .map(|(v, title)| MenuItem {
                    checked: month.map(|m| m.to_string()).unwrap_or_default() == v,
                    label: SharedString::from(title),
                    command: format!("{COMMAND}cardMonth:{v}"),
                })
                .collect();
            let year_items = std::iter::once((String::new(), "Year".to_owned()))
                .chain(years.iter().map(|y| (y.to_string(), y.to_string())))
                .map(|(v, title)| MenuItem {
                    checked: year.map(|y| y.to_string()).unwrap_or_default() == v,
                    label: SharedString::from(title),
                    command: format!("{COMMAND}cardYear:{v}"),
                })
                .collect();
            let expiry = div()
                .flex()
                .flex_row()
                .gap(px(8.))
                .child(menu_popup(
                    view,
                    "cardMonth".into(),
                    month.map_or("Month".to_owned(), |m| format!("{m:02}")),
                    90.,
                    month_items,
                ))
                .child(menu_popup(
                    view,
                    "cardYear".into(),
                    year.map_or("Year".to_owned(), |y| y.to_string()),
                    90.,
                    year_items,
                ))
                .into_any_element();
            let delete = saved.as_ref().map(|_| {
                button(
                    view,
                    "autofill-delete",
                    "Delete",
                    cmd(format!("{COMMAND}autofillDelete")),
                )
                .kind(ButtonKind::Destructive)
                .into_any_element()
            });
            let leading = saved
                .as_ref()
                .map(|card| crate::site::parts::network_badge(view.host.as_ref(), &card.network));
            Dialog::sheet("card-sheet", SheetSize::L, &p)
                .on_dismiss(dismiss)
                .child(dialog_title(
                    saved
                        .as_ref()
                        .map_or("Add Card".to_owned(), SavedCard::title),
                    None,
                    leading,
                    &p,
                ))
                .child(div().mt(px(20.)).child(group(
                    &p,
                    [
                        sheet_row(&p, "card-number".into(), "Card Number", number),
                        sheet_row(
                            &p,
                            "card-name".into(),
                            "Name on Card",
                            sheet_field(&p, fields.get(name_index), FIELD_WIDTH),
                        ),
                        sheet_row(&p, "card-expiry".into(), "Expiration Date", expiry),
                    ],
                )))
                .when_some(error, |this, error| {
                    this.child(
                        div()
                            .mt(px(10.))
                            .text_size(px(11.))
                            .text_color(p.destructive)
                            .child(error),
                    )
                })
                .child(dialog_actions(
                    delete,
                    None,
                    [cancel, save("Save", number_field && digits < 12)],
                    &p,
                ))
                .into_any_element()
        }
        Sheet::Engine { id, error } => {
            let label = |text: &'static str| {
                div()
                    .mt(px(12.))
                    .mb(px(4.))
                    .text_size(px(11.))
                    .text_color(p.text_secondary)
                    .child(text)
            };
            let field = |index: usize| {
                field_box(&p).h(px(22.)).child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .children(fields.get(index).cloned()),
                )
            };
            let delete = id.as_ref().map(|_| {
                button(
                    view,
                    "engine-delete",
                    "Delete",
                    cmd(format!("{COMMAND}engine:delete")),
                )
                .kind(ButtonKind::Destructive)
                .into_any_element()
            });
            Dialog::sheet("engine-sheet", SheetSize::M, &p)
                .on_dismiss(dismiss)
                .child(dialog_title(
                    if id.is_some() {
                        "Edit Search Engine"
                    } else {
                        "Add Search Engine"
                    },
                    None,
                    None,
                    &p,
                ))
                .child(label("Name"))
                .child(field(0))
                .child(label("Shortcut"))
                .child(field(1))
                .child(label("URL with %s in place of the query"))
                .child(field(2))
                .when_some(error, |this, error| {
                    this.child(
                        div()
                            .debug_selector(|| "engine-error".into())
                            .mt(px(10.))
                            .text_size(px(11.))
                            .text_color(p.destructive)
                            .child(error),
                    )
                })
                .child(dialog_actions(
                    delete,
                    None,
                    [
                        cancel,
                        save(if id.is_some() { "Save" } else { "Add" }, false),
                    ],
                    &p,
                ))
                .into_any_element()
        }
    };
    Some(element)
}

fn install_dialog(
    view: &SettingsWindowView,
    name: &str,
    icon: Option<String>,
    warnings: &[String],
    path: &str,
    error: Option<String>,
    busy: bool,
) -> AnyElement {
    use crate::popovers::extension_dialogs::{
        EXTENSION_ICON, NO_PERMISSIONS, PERMISSIONS_MAX_HEIGHT,
    };
    use crate::popovers::panel::{pill, primary_pill};
    use crate::primitives::sheets::{Dialog, dialog_actions, dialog_title};
    use crate::primitives::tokens::SheetSize;
    use ardia_theme::tokens::{TypeSize, space};
    let p = view.look.p;
    let emit = view.emit.clone();
    let send = move |command: &'static str| {
        let emit = emit.clone();
        move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut gpui::App| {
            emit.send(cmd(format!("{COMMAND}{command}")), window, cx)
        }
    };
    let close_emit = view.emit.clone();
    let dialog = Dialog::new("extension-install-sheet", SheetSize::S, &p)
        .animated(true)
        .on_dismiss(move |window, cx| {
            if !busy {
                close_emit.send(cmd(format!("{COMMAND}sheetClose")), window, cx)
            }
        });
    if let Some(error) = error {
        return dialog
            .child(dialog_title("Couldn't add the extension", None, None, &p))
            .child(
                div()
                    .debug_selector(|| "extension-install-error".into())
                    .mt(px(space::S))
                    .text_size(px(TypeSize::Body.points()))
                    .text_color(p.text_secondary)
                    .child(error),
            )
            .child(dialog_actions(
                None,
                None,
                [primary_pill("install-ok", "OK", &p, send("sheetClose"))],
                &p,
            ))
            .into_any_element();
    }
    let glyph = icon.map(|path| {
        gpui::img(std::path::PathBuf::from(path))
            .size(px(EXTENSION_ICON))
            .flex_none()
            .object_fit(gpui::ObjectFit::Contain)
            .into_any_element()
    });
    let body = if warnings.is_empty() {
        div()
            .mt(px(space::XL))
            .text_size(px(TypeSize::Body.points()))
            .text_color(p.text_secondary)
            .child(NO_PERMISSIONS)
            .into_any_element()
    } else {
        div()
            .child(
                div()
                    .mt(px(space::XL))
                    .mb(px(space::S))
                    .text_size(px(TypeSize::Body.points()))
                    .child("It can:"),
            )
            .child(
                div()
                    .id("settings-install-permissions")
                    .max_h(px(PERMISSIONS_MAX_HEIGHT))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .children(warnings.iter().map(|warning| {
                        div()
                            .mb(px(space::XS))
                            .flex()
                            .gap(px(space::M))
                            .text_size(px(TypeSize::Body.points()))
                            .text_color(p.text_secondary)
                            .child("•")
                            .child(div().flex_1().child(SharedString::from(warning.clone())))
                    })),
            )
            .into_any_element()
    };
    let cancel = pill("install-cancel", "Cancel", &p, {
        let close = send("sheetClose");
        move |event: &gpui::ClickEvent, window: &mut Window, cx: &mut gpui::App| {
            if !busy {
                close(event, window, cx)
            }
        }
    });
    let add = primary_pill(
        "install-accept",
        if busy { "Adding…" } else { "Add Extension" },
        &p,
        send("sheetSave"),
    );
    dialog
        .child(dialog_title(format!("Add “{name}”?"), None, glyph, &p))
        .child(body)
        .child(
            div()
                .debug_selector(|| "extension-install-path".into())
                .mt(px(space::ML))
                .text_size(px(TypeSize::Caption.points()))
                .text_color(p.text_tertiary)
                .line_clamp(2)
                .text_ellipsis()
                .child(format!("Loaded from {path}")),
        )
        .child(dialog_actions(None, None, [cancel, add], &p))
        .into_any_element()
}
