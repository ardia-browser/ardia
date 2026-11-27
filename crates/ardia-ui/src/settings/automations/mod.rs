pub mod calendar;
mod connect;
mod links;
mod live_folders;
mod parts;
mod rules;
#[cfg(test)]
mod tests;

use ardia_state::air_traffic::{OpenAs, SourceApp};
use ardia_state::live::LiveSourceId;
use ardia_state::{ProfileId, WindowId};
use gpui::{AppContext, Context, Entity, Subscription, Window};

use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::settings::SettingsWindowView;
use crate::settings::panes::Block;

pub use connect::ConnectSheet;
pub use rules::RuleSheet;

pub const COMMAND: &str = "automations:";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppLink {
    pub origin: String,
    pub scheme: String,
    pub app: Option<String>,
    pub icon: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveConnect {
    Token {
        source: LiveSourceId,
        token: String,
        user: Option<String>,
        site: Option<String>,
    },
    GithubDevice {
        client_id: String,
    },
    Google {
        window: WindowId,
        client_id: String,
        secret: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectProgress {
    Code(DeviceCode),
    Done(Result<(), String>),
}

pub use ardia_state::automation_rules::{ApprovalRule as ApprovedRule, LinkHookRow, LinkHookState};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutomationRulesView {
    pub pending: Vec<ApprovedRule>,
    pub approved: Vec<ApprovedRule>,
    pub link_hooks: Vec<LinkHookRow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    TestLink,
    RuleApp,
    RuleText,
    Token,
    User,
    Site,
    ClientId,
    Secret,
}

pub struct Fields {
    pub test_link: Entity<TextInput>,
    pub rule_app: Entity<TextInput>,
    pub rule_text: Entity<TextInput>,
    pub token: Entity<TextInput>,
    pub user: Entity<TextInput>,
    pub site: Entity<TextInput>,
    pub client_id: Entity<TextInput>,
    pub secret: Entity<TextInput>,
}

impl Fields {
    pub fn get(&self, field: Field) -> &Entity<TextInput> {
        match field {
            Field::TestLink => &self.test_link,
            Field::RuleApp => &self.rule_app,
            Field::RuleText => &self.rule_text,
            Field::Token => &self.token,
            Field::User => &self.user,
            Field::Site => &self.site,
            Field::ClientId => &self.client_id,
            Field::Secret => &self.secret,
        }
    }
}

pub struct Automations {
    pub fields: Fields,
    pub test_app: Option<SourceApp>,
    pub test_typed: String,
    pub rule_sheet: Option<RuleSheet>,
    pub connect_sheet: Option<ConnectSheet>,
    pub app_links_profile: Option<ProfileId>,
    _subscriptions: Vec<Subscription>,
}

impl Automations {
    pub fn new(
        style: InputStyle,
        window: &mut Window,
        cx: &mut Context<SettingsWindowView>,
    ) -> Automations {
        let make = |placeholder: &'static str, cx: &mut Context<SettingsWindowView>| {
            let input = cx.new(|cx| TextInput::new(placeholder, cx));
            input.update(cx, |input, cx| input.set_style(style, cx));
            input
        };
        let fields = Fields {
            test_link: make("Paste a link, like github.com/ardia", cx),
            rule_app: make("App name or bundle ID", cx),
            rule_text: make("", cx),
            token: make("", cx),
            user: make("", cx),
            site: make("", cx),
            client_id: make("", cx),
            secret: make("", cx),
        };
        let mut subscriptions = Vec::new();
        for field in [
            Field::TestLink,
            Field::RuleApp,
            Field::RuleText,
            Field::Token,
            Field::User,
            Field::Site,
            Field::ClientId,
            Field::Secret,
        ] {
            subscriptions.push(cx.subscribe_in(
                fields.get(field),
                window,
                move |view: &mut SettingsWindowView, _, event: &InputEvent, window, cx| {
                    on_input(view, field, event, window, cx)
                },
            ));
        }
        Automations {
            fields,
            test_app: None,
            test_typed: String::new(),
            rule_sheet: None,
            connect_sheet: None,
            app_links_profile: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn has_sheet(&self) -> bool {
        self.rule_sheet.is_some() || self.connect_sheet.is_some()
    }
}

pub fn text(view: &SettingsWindowView, field: Field, cx: &gpui::App) -> String {
    view.automations
        .fields
        .get(field)
        .read(cx)
        .text()
        .to_owned()
}

fn on_input(
    view: &mut SettingsWindowView,
    field: Field,
    event: &InputEvent,
    window: &mut Window,
    cx: &mut Context<SettingsWindowView>,
) {
    match (field, event) {
        (Field::TestLink, InputEvent::Changed { .. }) => {
            view.automations.test_typed = text(view, Field::TestLink, cx);
            cx.notify();
        }
        (Field::RuleApp | Field::RuleText, InputEvent::Changed { .. }) => {
            if let Some(sheet) = view.automations.rule_sheet.as_mut() {
                sheet.error = None;
            }
            cx.notify();
        }
        (Field::RuleApp | Field::RuleText, InputEvent::Submit(_)) => rules::save(view, cx),
        (Field::Token | Field::User | Field::Site | Field::ClientId | Field::Secret, event) => {
            match event {
                InputEvent::Changed { .. } => cx.notify(),
                InputEvent::Submit(_) => connect::submit(view, field, window, cx),
                _ => {}
            }
        }
        (_, InputEvent::Cancel) => close_sheet(view, cx),
        _ => {}
    }
}

pub fn close_sheet(view: &mut SettingsWindowView, cx: &mut Context<SettingsWindowView>) {
    if view.automations.connect_sheet.take().is_some() {
        view.host.cancel_live_connect();
    }
    view.automations.rule_sheet = None;
    view.menu = None;
    cx.notify();
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
        "calendarConnect" => calendar::connect(view),
        "calendarPrivacy" => calendar::open_privacy(view),
        "calendarHidden" => calendar::set_hidden(view, argument),
        "calendarPatch" => calendar::patch(view, argument),
        "refresh" => live_folders::refresh(view, argument),
        "deleteFolder" => live_folders::delete(view, argument),
        "folderOption" => live_folders::set_option(view, argument),
        "disconnect" => live_folders::disconnect(view, argument),
        "connect" => connect::open(view, argument, window, cx),
        "connectCancel" | "sheetClose" => close_sheet(view, cx),
        "connectGo" => connect::go(view, window, cx),
        "deviceGo" => connect::device_go(view, window, cx),
        "deviceCancel" => connect::device_cancel(view, cx),
        "deviceOpen" => connect::device_open(view, cx),
        "addRule" => rules::open(view, None, window, cx),
        "editRule" => rules::open(view, Some(argument), window, cx),
        "ruleSave" => rules::save(view, cx),
        "ruleRemove" => rules::remove_from_sheet(view, cx),
        "ruleFrom" => rules::pick_from(view, argument, window, cx),
        "ruleKind" => rules::pick_kind(view, argument, window, cx),
        "ruleProfile" => rules::pick_profile(view, argument, cx),
        "ruleOpen" => rules::pick_open(view, argument, cx),
        "ruleGroup" => rules::pick_group(view, argument, cx),
        "ruleEnabled" => rules::set_enabled(view, argument),
        "ruleMove" => rules::move_rule(view, argument),
        "ruleDelete" => rules::delete(view, argument),
        "testApp" => links::pick_test_app(view, argument, cx),
        "fallback" => links::set_fallback(view, argument),
        "fallbackOpen" => links::set_fallback_open(view, argument),
        "fallbackGroup" => links::set_fallback_group(view, argument),
        "appLinksProfile" => links::pick_app_links_profile(view, argument, cx),
        "removeAppLink" => links::remove_app_link(view, argument),
        "revokeRule" => view.host.revoke_automation_rule(argument.to_owned()),
        "approveRule" => view.host.approve_automation_rule(argument.to_owned()),
        "automationPane" => view.go_to(crate::settings::rows::Pane::Advanced, cx),
        _ => {}
    }
    cx.notify();
}

pub fn blocks(view: &SettingsWindowView) -> Vec<Block> {
    let mut blocks = Vec::new();
    blocks.extend(calendar::blocks(view));
    blocks.extend(live_folders::blocks(view));
    blocks.extend(links::blocks(view));
    blocks
}

pub const BLOCK_OF: &[(&str, usize)] = &[
    ("automations.calendarAccess", 1),
    ("automations.meetingAlert", 1),
    ("automations.meetingAlertCondition", 1),
    ("automations.calendarPreview", 1),
    ("automations.countdown", 1),
    ("automations.groupMeetingTabs", 1),
    ("automations.liveFolders", 3),
    ("automations.github", 6),
    ("automations.bitbucket", 6),
    ("automations.notion", 6),
    ("automations.confluence", 6),
    ("automations.gdrive", 6),
    ("automations.linkRules", 8),
    ("automations.testLink", 9),
    ("automations.linkFallback", 10),
    ("automations.linkFallbackGroup", 10),
    ("automations.appLinks", 11),
];

pub fn block_index(id: &str) -> Option<usize> {
    BLOCK_OF
        .iter()
        .find(|(anchor, _)| *anchor == id)
        .map(|(_, index)| *index)
}

pub fn open_label(open: OpenAs) -> &'static str {
    ardia_state::link_routing::open_label(open)
}

pub fn automation_rule_rows(view: &SettingsWindowView) -> Vec<gpui::AnyElement> {
    rules::approvals(view)
}

pub fn sheet(view: &SettingsWindowView, cx: &gpui::App) -> Option<gpui::AnyElement> {
    if let Some(sheet) = &view.automations.connect_sheet {
        return Some(connect::sheet(view, sheet, cx));
    }
    view.automations
        .rule_sheet
        .as_ref()
        .map(|sheet| rules::sheet(view, sheet))
}
