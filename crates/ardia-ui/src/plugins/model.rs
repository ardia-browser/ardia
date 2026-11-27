use ardia_state::{TabId, WindowId};
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Child {
    Text(String),
    Node(PluginNode),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PluginNode {
    pub kind: String,
    pub key: Option<String>,
    pub props: Map<String, Value>,
    pub children: Vec<Child>,
}

impl PluginNode {
    pub fn new(kind: &str) -> Self {
        PluginNode {
            kind: kind.to_owned(),
            ..PluginNode::default()
        }
    }

    pub fn prop(&self, name: &str) -> Option<&Value> {
        self.props.get(name)
    }

    pub fn with_prop(mut self, name: &str, value: Value) -> Self {
        self.props.insert(name.to_owned(), value);
        self
    }

    pub fn with_child(mut self, child: PluginNode) -> Self {
        self.children.push(Child::Node(child));
        self
    }

    pub fn with_text(mut self, text: &str) -> Self {
        self.children.push(Child::Text(text.to_owned()));
        self
    }

    pub fn nodes(&self) -> impl Iterator<Item = &PluginNode> {
        self.children.iter().filter_map(|child| match child {
            Child::Node(node) => Some(node),
            Child::Text(_) => None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceKind {
    Sidebar,
    Popover,
    Panel,
    Command,
}

impl SurfaceKind {
    pub fn wire(self) -> &'static str {
        match self {
            SurfaceKind::Sidebar => "sidebar",
            SurfaceKind::Popover => "popover",
            SurfaceKind::Panel => "panel",
            SurfaceKind::Command => "command",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceMount {
    pub plugin: String,
    pub instance: String,
    pub view: String,
    pub kind: SurfaceKind,
    pub window: WindowId,
    pub context: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickPickItem {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub icon: Option<String>,
    pub badge: Option<String>,
    pub keywords: Vec<String>,
    pub picked: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuickPickOptions {
    pub title: Option<String>,
    pub placeholder: Option<String>,
    pub can_pick_many: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuickPickRequest {
    pub id: u64,
    pub plugin: String,
    pub plugin_title: Option<String>,
    pub window: WindowId,
    pub items: Vec<QuickPickItem>,
    pub options: QuickPickOptions,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputBoxOptions {
    pub title: String,
    pub message: Option<String>,
    pub placeholder: Option<String>,
    pub value: Option<String>,
    pub password: bool,
    pub confirm_title: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputBoxRequest {
    pub id: u64,
    pub plugin: String,
    pub plugin_title: Option<String>,
    pub window: WindowId,
    pub options: InputBoxOptions,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandView {
    pub plugin: String,
    pub view: String,
    pub title: String,
    pub icon: String,
    pub command: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Anchor {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginPopover {
    pub plugin: String,
    pub item: String,
    pub view: String,
    pub anchor: Anchor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tone {
    Default,
    Secondary,
    Tertiary,
    Accent,
    Success,
    Warning,
    Destructive,
}

impl Tone {
    pub const ALL: [(&'static str, Tone); 7] = [
        ("default", Tone::Default),
        ("secondary", Tone::Secondary),
        ("tertiary", Tone::Tertiary),
        ("accent", Tone::Accent),
        ("success", Tone::Success),
        ("warning", Tone::Warning),
        ("destructive", Tone::Destructive),
    ];

    pub fn parse(text: &str) -> Option<Tone> {
        Tone::ALL
            .iter()
            .find(|(name, _)| *name == text)
            .map(|(_, tone)| *tone)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ToolbarBadge {
    Dot,
    Count(i64),
    Text(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolbarUpdate {
    pub icon: Option<String>,
    pub label: Option<Option<String>>,
    pub badge: Option<Option<ToolbarBadge>>,
    pub tooltip: Option<Option<String>>,
    pub tone: Option<Tone>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolbarEntry {
    pub key: String,
    pub plugin: String,
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub tooltip: Option<String>,
    pub state: ToolbarUpdate,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PanelContent {
    Missing,
    File(String),
    Surface { view: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SidePanelCard {
    pub plugin: String,
    pub panel: String,
    pub generation: u64,
    pub title: String,
    pub icon: String,
    pub content: PanelContent,
}

impl SidePanelCard {
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.plugin, self.panel, self.generation)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SidePanelState {
    pub shown: Option<SidePanelCard>,
    pub retained: Vec<SidePanelCard>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentVerb {
    Install,
    Update,
    TurnOn,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsentLine {
    pub icon: String,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentOwner {
    Window,
    Settings,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsentRequest {
    pub id: u64,
    pub name: String,
    pub hash: String,
    pub owner: ConsentOwner,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub verb: ConsentVerb,
    pub changed: bool,
    pub lines: Vec<ConsentLine>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteSwitchRow {
    pub plugin: String,
    pub key: String,
    pub title: String,
    pub icon: String,
    pub on: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarViewEntry {
    pub plugin: String,
    pub id: String,
    pub title: String,
    pub icon: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HostAction {
    SiteControls,
    Address,
    CopyLink,
    Console,
    Network,
    Inspect,
    Extensions,
    Split,
}

impl HostAction {
    pub const ALL: [HostAction; 8] = [
        HostAction::SiteControls,
        HostAction::Address,
        HostAction::CopyLink,
        HostAction::Console,
        HostAction::Network,
        HostAction::Inspect,
        HostAction::Extensions,
        HostAction::Split,
    ];

    pub fn name(self) -> &'static str {
        match self {
            HostAction::SiteControls => "siteControls",
            HostAction::Address => "address",
            HostAction::CopyLink => "copyLink",
            HostAction::Console => "console",
            HostAction::Network => "network",
            HostAction::Inspect => "inspect",
            HostAction::Extensions => "extensions",
            HostAction::Split => "split",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            HostAction::SiteControls => "Site Controls",
            HostAction::Address => "Edit Address",
            HostAction::CopyLink => "Copy URL",
            HostAction::Console => "Toggle Console",
            HostAction::Network => "Toggle Network Panel",
            HostAction::Inspect => "Inspect Element",
            HostAction::Extensions => "Extensions",
            HostAction::Split => "Split View Options",
        }
    }

    pub fn consent(self) -> &'static str {
        match self {
            HostAction::SiteControls => "open Site Controls",
            HostAction::Address => "edit the address",
            HostAction::CopyLink => "copy the page address",
            HostAction::Console => "open the Console",
            HostAction::Network => "open the Network panel",
            HostAction::Inspect => "inspect an element",
            HostAction::Extensions => "run your extensions",
            HostAction::Split => "add a split",
        }
    }

    pub fn parse(text: &str) -> Option<HostAction> {
        HostAction::ALL
            .into_iter()
            .find(|action| action.name() == text)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PageBarButton {
    Action(HostAction),
    Divider,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PageBarMatch {
    pub plugin: String,
    pub url: String,
    pub at: u64,
    pub buttons: Vec<PageBarButton>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PluginPageState {
    PrivateWindow,
    Off { title: String },
    Surface { view: String, panel: String },
    Starting { title: String },
    Stopped { title: String },
    File { url: String, context: Option<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProgramsStatus {
    Linking,
    Linked {
        linked: Vec<String>,
        refused: Vec<(String, String)>,
        bin_dir: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginPrograms {
    pub plugin: String,
    pub title: String,
    pub programs: Vec<String>,
    pub status: ProgramsStatus,
}

impl PluginPrograms {
    pub fn can_relink(&self) -> bool {
        match &self.status {
            ProgramsStatus::Failed { .. } => true,
            ProgramsStatus::Linked { refused, .. } => !refused.is_empty(),
            ProgramsStatus::Linking => false,
        }
    }

    pub fn line(&self) -> String {
        match &self.status {
            ProgramsStatus::Linked {
                linked, refused, ..
            } => {
                if !refused.is_empty() {
                    refused
                        .iter()
                        .map(|(name, reason)| format!("{name}: {reason}"))
                        .collect::<Vec<_>>()
                        .join("; ")
                } else if linked.is_empty() {
                    "Nothing on your PATH.".to_owned()
                } else {
                    format!("On your PATH: {}", linked.join(", "))
                }
            }
            ProgramsStatus::Failed { reason } => format!("Not on your PATH: {reason}"),
            ProgramsStatus::Linking => "Putting it on your PATH\u{2026}".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginMenuEntry {
    pub plugin: String,
    pub plugin_title: String,
    pub plugin_icon: Option<String>,
    pub command: String,
    pub title: String,
    pub icon: Option<String>,
    pub when: Option<String>,
    pub command_when: Option<String>,
}

pub trait PluginHost: Send + Sync {
    fn window_eligible(&self, window: &WindowId) -> bool;

    fn surface_tree(&self, plugin: &str, instance: &str) -> Option<PluginNode>;

    fn mount_surface(&self, mount: SurfaceMount);

    fn unmount_surface(&self, plugin: &str, instance: &str, window: &WindowId);

    fn fire(
        &self,
        plugin: &str,
        instance: &str,
        window: &WindowId,
        handler: &str,
        args: Vec<Value>,
        gesture: bool,
    ) -> bool;

    fn open_url(&self, window: &WindowId, url: &str);

    fn quick_pick(&self) -> Option<QuickPickRequest> {
        None
    }

    fn resolve_quick_pick(&self, id: u64, picked: Option<Vec<String>>) {
        let _ = (id, picked);
    }

    fn input_box(&self) -> Option<InputBoxRequest> {
        None
    }

    fn resolve_input_box(&self, id: u64, value: Option<String>) {
        let _ = (id, value);
    }

    fn command_view(&self, window: &WindowId) -> Option<CommandView> {
        let _ = window;
        None
    }

    fn close_command_view(&self, window: &WindowId) {
        let _ = window;
    }

    fn popover(&self, window: &WindowId) -> Option<PluginPopover> {
        let _ = window;
        None
    }

    fn close_popover(&self, window: &WindowId) {
        let _ = window;
    }

    fn toolbar_items(&self) -> Vec<ToolbarEntry> {
        Vec::new()
    }

    fn run_toolbar_item(&self, window: &WindowId, plugin: &str, item: &str, anchor: Anchor) {
        let _ = (window, plugin, item, anchor);
    }

    fn plugin_programs(&self) -> Vec<PluginPrograms> {
        Vec::new()
    }

    fn programs_registry_unreadable(&self) -> bool {
        false
    }

    fn relink_programs(&self, plugin: &str) -> Result<(), String> {
        let _ = plugin;
        Err("This plugin has no programs.".to_owned())
    }

    fn omnibox_providers(
        &self,
        window: &WindowId,
    ) -> Vec<ardia_state::omnibox::providers::PluginProvider> {
        let _ = window;
        Vec::new()
    }

    fn query_omnibox_provider(
        &self,
        id: &str,
        text: &str,
    ) -> futures::channel::oneshot::Receiver<Vec<ardia_state::omnibox::providers::ProviderRow>>
    {
        let _ = (id, text);
        let (answer, reply) = futures::channel::oneshot::channel();
        let _ = answer.send(Vec::new());
        reply
    }

    fn side_panel(&self, window: &WindowId) -> SidePanelState {
        let _ = window;
        SidePanelState::default()
    }

    fn close_side_panel(&self, window: &WindowId, plugin: &str) {
        let _ = (window, plugin);
    }

    fn consent(&self) -> Option<ConsentRequest> {
        None
    }

    fn answer_consent(&self, owner: ConsentOwner, id: u64, confirm: bool) -> bool {
        let _ = (owner, id, confirm);
        false
    }

    fn site_switch_rows(&self, tab: &TabId) -> Vec<SiteSwitchRow> {
        let _ = tab;
        Vec::new()
    }

    fn set_site_switch(&self, plugin: &str, key: &str, url: &str, on: bool) {
        let _ = (plugin, key, url, on);
    }

    fn sidebar_views(&self) -> Vec<SidebarViewEntry> {
        Vec::new()
    }

    fn page_bar(&self, window: &WindowId, tab: &TabId) -> Option<PageBarMatch> {
        let _ = (window, tab);
        None
    }

    fn run_host_action(&self, action: HostAction, window: &WindowId, tab: &TabId) {
        let _ = (action, window, tab);
    }

    fn page(&self, tab: &TabId, name: &str) -> Option<PluginPageState> {
        let _ = (tab, name);
        None
    }

    fn open_plugin_settings(&self, name: &str) {
        let _ = name;
    }

    fn has_plugin(&self, name: &str) -> bool {
        let _ = name;
        false
    }

    fn ask_consent(&self, name: &str, owner: ConsentOwner) -> bool {
        let _ = (name, owner);
        false
    }

    fn turn_off(&self, name: &str) -> bool {
        let _ = name;
        false
    }

    fn run_command(&self, window: &WindowId, plugin: &str, command: &str) -> bool {
        let _ = (window, plugin, command);
        false
    }

    fn menu_entries(&self, slot: &str) -> Vec<PluginMenuEntry> {
        let _ = slot;
        Vec::new()
    }

    fn run_menu_command(
        &self,
        window: &WindowId,
        plugin: &str,
        command: &str,
        context: serde_json::Map<String, serde_json::Value>,
    ) -> bool {
        let _ = context;
        self.run_command(window, plugin, command)
    }

    fn file_view(
        &self,
        window: &WindowId,
        plugin: &str,
        url: &str,
        key: &str,
        context: Option<String>,
    ) -> Option<ardia_engine::NativeViewHandle> {
        let _ = (window, plugin, url, key, context);
        None
    }

    fn release_file_view(&self, key: &str) {
        let _ = key;
    }

    fn setting_rows(&self, plugin: &str) -> Vec<SettingRow> {
        let _ = plugin;
        Vec::new()
    }

    fn set_setting(&self, plugin: &str, key: &str, value: SettingValue) -> bool {
        let _ = (plugin, key, value);
        false
    }

    fn secret_row_is_set(&self, plugin: &str, key: &str) -> bool {
        let _ = (plugin, key);
        false
    }

    fn set_secret_row(&self, plugin: &str, key: &str, value: Option<&str>) -> Result<(), String> {
        let _ = (plugin, key, value);
        Err(format!("{plugin} has no secret row {key}."))
    }

    fn turn_on_approved(&self, plugin: &str) -> bool {
        let _ = plugin;
        false
    }

    fn bar_actions(&self) -> Vec<PluginBarAction> {
        Vec::new()
    }

    fn open_plugin_page(&self, window: &WindowId, plugin: &str) {
        let _ = (window, plugin);
    }

    fn remove_plugin(&self, plugin: &str) -> bool {
        let _ = plugin;
        false
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginBarAction {
    pub plugin: String,
    pub action: String,
    pub title: String,
    pub icon: Option<String>,
    pub keywords: Vec<String>,
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SettingValue {
    Bool(bool),
    Text(String),
    Number(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub enum SettingKind {
    Toggle,
    Text,
    Number {
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    Choice {
        choices: Vec<(String, String)>,
    },
    Secret {
        placeholder: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct SettingRow {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub kind: SettingKind,
    pub value: SettingValue,
}
