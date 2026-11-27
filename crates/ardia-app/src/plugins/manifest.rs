use serde_json::{Map, Value};

pub const MANIFEST_VERSION: i64 = 2;
pub const MANIFEST_FILE: &str = "plugin.json";
pub const PAGE_PANEL_ID: &str = "default";
pub const DEFAULT_SIDECAR_MB: u32 = 1024;
pub const DEFAULT_MAIN_MB: u32 = 256;

pub(crate) mod limits {
    pub const TITLE: usize = 60;
    pub const DESCRIPTION: usize = 200;
    pub const PAGE_TITLE: usize = 40;
    pub const ROWS: usize = 20;
    pub const ROW_TEXT: usize = 200;
    pub const CHOICES: (usize, usize) = (2, 12);
    pub const COMMANDS: usize = 20;
    pub const KEYWORDS: usize = 8;
    pub const KEYWORD: usize = 40;
    pub const PLUGIN_KEYWORDS: usize = 12;
    pub const EXAMPLE: usize = 120;
    pub const TELEMETRY_ITEMS: usize = 16;
    pub const TELEMETRY_ITEM: usize = 800;
    pub const TOOLS: usize = 32;
    pub const TOOL_TIMEOUT: (i64, i64) = (1, 300);
    pub const ARGV: usize = 32;
    pub const ARG_BYTES: usize = 1024;
    pub const MEMORY_MB: (i64, i64) = (64, 4096);
    pub const PROGRAMS: usize = 4;
    pub const AFTER_UPDATE: (usize, usize) = (4, 8);
    pub const HOOKS: usize = 64;
    pub const MENU_ITEMS: usize = 8;
    pub const TOOLBAR: usize = 4;
    pub const SIDEBAR_VIEWS: usize = 4;
    pub const PANELS: usize = 8;
    pub const OMNIBOX: usize = 4;
    pub const THEMES: usize = 8;
    pub const ACTIVATION_EVENTS: usize = 32;
    pub const ALLOWED_HOSTS: usize = 32;
    pub const TOOLTIP: usize = 120;
    pub const SITE_SWITCHES: usize = 4;
    pub const PAGE_BAR_BUTTONS: usize = 16;
    pub const SWITCH_TITLE: usize = 40;
}

pub const NAME_RULE: &str =
    "1 to 40 lowercase letters, digits and dashes, starting with a letter or digit";
pub const KEY_RULE: &str = "1 to 40 letters, digits, - and _";
pub const SYMBOL_RULE: &str = "an SF Symbol name";

pub const HOST_ACTIONS: [(&str, &str); 8] = [
    ("siteControls", "open Site Controls"),
    ("address", "edit the address"),
    ("copyLink", "copy the page address"),
    ("console", "open the Console"),
    ("network", "open the Network panel"),
    ("inspect", "inspect an element"),
    ("extensions", "run your extensions"),
    ("split", "add a split"),
];

pub const STATE_TOPICS: [&str; 4] = ["tabs", "workspace", "navigation", "downloads"];
pub const STATE_INTENTS: [&str; 9] = [
    "tabs.group",
    "tabs.ungroup",
    "tabs.move",
    "tabs.pin",
    "tabs.unpin",
    "tabs.mute",
    "tabs.unmute",
    "tabs.activate",
    "groups.update",
];
const TOPICS_NEEDING_TABS: [&str; 3] = ["tabs", "workspace", "navigation"];

pub const RESERVED_PAGE_NAMES: [&str; 12] = [
    "history",
    "bookmarks",
    "downloads",
    "newtab",
    "settings",
    "about",
    "chrome",
    "chrome-urls",
    "credits",
    "extensions",
    "flags",
    "version",
];

pub fn is_name(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && text.len() <= 40
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn is_key(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 40
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn is_symbol(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.')
}

fn is_keyword(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn is_version(text: &str) -> bool {
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre.len() <= 40
                && pre
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        })
}

fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn unsafe_text(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c,
            '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '\u{061c}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}')
    })
}

pub fn is_plugin_path(value: &str) -> bool {
    !value.is_empty()
        && js_len(value) <= limits::ARG_BYTES
        && !value.starts_with('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn is_argument(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|a| !a.is_empty() && a.len() <= limits::ARG_BYTES && !a.contains('\0'))
}

pub fn is_page_path(value: &str) -> bool {
    value.starts_with('/')
        && js_len(value) <= 512
        && !value.starts_with("//")
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
}

#[derive(Default)]
pub struct Check {
    pub problems: Vec<String>,
}

fn at(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_owned()
    } else {
        format!("{path}.{key}")
    }
}

fn at_index(path: &str, index: usize) -> String {
    format!("{path}[{index}]")
}

impl Check {
    fn push(&mut self, problem: impl Into<String>) {
        self.problems.push(problem.into());
    }

    fn only(&mut self, path: &str, doc: &Map<String, Value>, keys: &[&str]) {
        for key in doc.keys() {
            if !keys.contains(&key.as_str()) {
                let of = if path.is_empty() {
                    "of a plugin".to_owned()
                } else {
                    format!("of {path}")
                };
                self.push(format!("{} isn't a key {of}", at(path, key)));
            }
        }
    }

    fn text(
        &mut self,
        path: &str,
        value: Option<&Value>,
        max: usize,
        required: bool,
    ) -> Option<String> {
        if value.is_none() && !required {
            return None;
        }
        match value.and_then(Value::as_str) {
            Some(text) if !text.trim().is_empty() && js_len(text) <= max => {
                if unsafe_text(text) {
                    self.push(format!("{path} has control or direction characters"));
                    None
                } else {
                    Some(text.to_owned())
                }
            }
            _ => {
                self.push(format!("{path} must be text of 1 to {max} characters"));
                None
            }
        }
    }

    fn matching(
        &mut self,
        path: &str,
        value: Option<&Value>,
        test: fn(&str) -> bool,
        rule: &str,
        required: bool,
    ) -> Option<String> {
        if value.is_none() && !required {
            return None;
        }
        match value.and_then(Value::as_str) {
            Some(text) if test(text) => Some(text.to_owned()),
            _ => {
                self.push(format!("{path} must be {rule}"));
                None
            }
        }
    }

    fn list<'a>(&mut self, path: &str, value: Option<&'a Value>, max: usize) -> Vec<&'a Value> {
        match value {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= max => items.iter().collect(),
            Some(_) => {
                self.push(format!("{path} must be a list of at most {max}"));
                Vec::new()
            }
        }
    }

    fn object<'a>(
        &mut self,
        path: &str,
        value: Option<&'a Value>,
    ) -> Option<&'a Map<String, Value>> {
        match value {
            Some(Value::Object(fields)) => Some(fields),
            _ => {
                self.push(format!("{path} must be an object"));
                None
            }
        }
    }

    fn integer(
        &mut self,
        path: &str,
        value: Option<&Value>,
        (min, max): (i64, i64),
        fallback: i64,
    ) -> i64 {
        let Some(value) = value else {
            return fallback;
        };
        match value.as_f64() {
            Some(n) if n.fract() == 0.0 && n >= min as f64 && n <= max as f64 => n as i64,
            _ => {
                self.push(format!("{path} must be a whole number from {min} to {max}"));
                fallback
            }
        }
    }

    fn flag(&mut self, path: &str, value: Option<&Value>) -> bool {
        match value {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                self.push(format!("{path} must be true or false"));
                false
            }
        }
    }

    fn unique(&mut self, path: &str, names: &[String], what: &str) {
        let mut seen = std::collections::HashSet::new();
        for name in names {
            if !seen.insert(name.as_str()) {
                self.push(format!("{path} has two {what} named {name}"));
            }
        }
    }

    fn symbol_of(&mut self, path: &str, value: Option<&Value>) -> String {
        self.matching(path, value, is_symbol, SYMBOL_RULE, false)
            .unwrap_or_else(|| "puzzlepiece".to_owned())
    }

    fn plugin_file(
        &mut self,
        path: &str,
        value: Option<&Value>,
        rule: &str,
        extension: Option<&str>,
    ) -> Option<String> {
        match value.and_then(Value::as_str) {
            Some(file)
                if is_plugin_path(file)
                    && extension.is_none_or(|ext| file.to_lowercase().ends_with(ext)) =>
            {
                Some(file.to_owned())
            }
            _ => {
                self.push(format!("{path} must be {rule}"));
                None
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Network {
    Off,
    Any,
    Hosts(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateAccess {
    pub events: Vec<String>,
    pub intents: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Permissions {
    pub tabs: Option<String>,
    pub full_urls: bool,
    pub active_page: bool,
    pub workspace: bool,
    pub commands: bool,
    pub storage: bool,
    pub secrets: bool,
    pub network: Network,
    pub control: bool,
    pub state: Option<StateAccess>,
}

impl Default for Permissions {
    fn default() -> Self {
        Permissions {
            tabs: None,
            full_urls: false,
            active_page: false,
            workspace: false,
            commands: false,
            storage: false,
            secrets: false,
            network: Network::Off,
            control: false,
            state: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MainSpec {
    pub entry: String,
    pub memory_mb: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidecarSpec {
    pub run: Vec<String>,
    pub memory_mb: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramSpec {
    pub name: String,
    pub path: String,
    pub after_update: Vec<Vec<String>>,
    pub example: Option<String>,
    pub claim: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CommandAction {
    Tool {
        tool: String,
        input: Map<String, Value>,
    },
    Open {
        split: bool,
        context: bool,
        side: String,
        side_setting: Option<String>,
        path: String,
    },
    View(String),
    Panel(String),
    Handler,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CommandSpec {
    pub name: String,
    pub title: String,
    pub icon: String,
    pub keywords: Vec<String>,
    pub when: Option<String>,
    pub action: CommandAction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolSpec {
    pub name: String,
    pub title: String,
    pub description: String,
    pub timeout: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RowKind {
    Toggle(bool),
    Text(String),
    Number {
        default: f64,
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    Choice {
        default: String,
        choices: Vec<(String, String)>,
    },
    Secret {
        placeholder: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct RowSpec {
    pub key: String,
    pub title: String,
    pub description: Option<String>,
    pub kind: RowKind,
}

impl RowSpec {
    pub fn type_name(&self) -> &'static str {
        match self.kind {
            RowKind::Toggle(_) => "toggle",
            RowKind::Text(_) => "text",
            RowKind::Number { .. } => "number",
            RowKind::Choice { .. } => "choice",
            RowKind::Secret { .. } => "secret",
        }
    }

    pub fn default_value(&self) -> Value {
        match &self.kind {
            RowKind::Toggle(on) => Value::Bool(*on),
            RowKind::Text(text) => Value::String(text.clone()),
            RowKind::Number { default, .. }
                if default.fract() == 0.0 && default.abs() <= 9_007_199_254_740_991.0 =>
            {
                serde_json::json!(*default as i64)
            }
            RowKind::Number { default, .. } => serde_json::json!(default),
            RowKind::Choice { default, .. } => Value::String(default.clone()),
            RowKind::Secret { .. } => Value::String(String::new()),
        }
    }

    pub fn value_of(&self, given: Option<&Value>) -> Value {
        match (&self.kind, given) {
            (RowKind::Toggle(_), Some(Value::Bool(on))) => Value::Bool(*on),
            (RowKind::Text(_), Some(Value::String(text)))
                if js_len(text) <= limits::ROW_TEXT && !unsafe_text(text) =>
            {
                Value::String(text.clone())
            }
            (RowKind::Number { min, max, .. }, Some(Value::Number(n))) => {
                let value = n.as_f64().unwrap_or(f64::NAN);
                if value.is_finite()
                    && value.abs() <= 1e12
                    && min.is_none_or(|m| value >= m)
                    && max.is_none_or(|m| value <= m)
                {
                    Value::Number(n.clone())
                } else {
                    self.default_value()
                }
            }
            (RowKind::Choice { choices, .. }, Some(Value::String(text)))
                if choices.iter().any(|(v, _)| v == text) =>
            {
                Value::String(text.clone())
            }
            _ => self.default_value(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SettingsSpec {
    pub defaults: Map<String, Value>,
    pub rows: Vec<RowSpec>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuContribution {
    pub command: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub when: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolbarItem {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub command: Option<String>,
    pub view: Option<String>,
    pub tooltip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarView {
    pub id: String,
    pub title: String,
    pub icon: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PanelMode {
    Sidecar,
    Tab,
    Split,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelSpec {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub mode: PanelMode,
    pub file: Option<String>,
    pub view: Option<String>,
    pub retain_context: bool,
    pub side: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmniboxSpec {
    pub id: String,
    pub title: String,
    pub keyword: Option<String>,
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThemeSpec {
    pub id: String,
    pub title: String,
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteSwitchSpec {
    pub key: String,
    pub title: String,
    pub icon: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageBarSpec {
    pub site_switch: String,
    pub local_addresses: Option<String>,
    pub buttons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordManagerSpec {
    pub fields: Vec<String>,
    pub verification_code_setup: bool,
    pub passkeys: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Contributions {
    pub commands: Vec<CommandSpec>,
    pub tools: Vec<ToolSpec>,
    pub hooks: Vec<String>,
    pub settings: SettingsSpec,
    pub programs: Vec<ProgramSpec>,
    pub password_manager: Option<PasswordManagerSpec>,
    pub menus_tab: Vec<MenuContribution>,
    pub menus_group: Vec<MenuContribution>,
    pub toolbar: Vec<ToolbarItem>,
    pub sidebar_views: Vec<SidebarView>,
    pub panels: Vec<PanelSpec>,
    pub omnibox: Vec<OmniboxSpec>,
    pub themes: Vec<ThemeSpec>,
    pub site_switches: Vec<SiteSwitchSpec>,
    pub page_bar: Option<PageBarSpec>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PageSpec {
    pub title: String,
    pub icon: String,
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelemetryDisclosure {
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginManifest {
    pub declared_manifest: i64,
    pub name: String,
    pub title: String,
    pub description: String,
    pub version: Option<String>,
    pub requires: Option<String>,
    pub icon: Option<String>,
    pub keywords: Vec<String>,
    pub telemetry: Option<TelemetryDisclosure>,
    pub permissions: Permissions,
    pub main: Option<MainSpec>,
    pub sidecar: Option<SidecarSpec>,
    pub activation_events: Vec<String>,
    pub contributes: Contributions,
    pub always_on: bool,
    pub official: bool,
    pub auto_install: bool,
    pub page: Option<PageSpec>,
}

impl PluginManifest {
    pub fn view_ids(&self) -> Vec<String> {
        let k = &self.contributes;
        let mut out: Vec<String> = Vec::new();
        let mut add = |id: &str| {
            if !out.iter().any(|known| known == id) {
                out.push(id.to_owned());
            }
        };
        k.sidebar_views.iter().for_each(|v| add(&v.id));
        k.panels
            .iter()
            .filter_map(|p| p.view.as_deref())
            .for_each(&mut add);
        k.toolbar
            .iter()
            .filter_map(|t| t.view.as_deref())
            .for_each(&mut add);
        for command in &k.commands {
            if let CommandAction::View(view) = &command.action {
                add(view);
            }
        }
        out
    }

    pub fn starts_eagerly(&self) -> bool {
        starts_eagerly(&self.activation_events)
    }

    pub fn needs_host(&self) -> bool {
        self.main.is_some() || self.sidecar.is_some()
    }

    pub fn runs_eagerly(&self) -> bool {
        self.needs_host() && (self.main.is_none() || self.starts_eagerly())
    }

    pub fn default_values(&self) -> Map<String, Value> {
        self.contributes
            .settings
            .rows
            .iter()
            .filter(|r| !matches!(r.kind, RowKind::Secret { .. }))
            .map(|r| (r.key.clone(), r.default_value()))
            .collect()
    }
}

pub fn starts_eagerly(events: &[String]) -> bool {
    events
        .iter()
        .any(|e| e == "*" || e == "onStartupFinished" || e.starts_with("onEvent:"))
}

pub fn page_panel_of(panels: &[PanelSpec]) -> Option<&PanelSpec> {
    let pages: Vec<&PanelSpec> = panels
        .iter()
        .filter(|p| p.file.is_some() && matches!(p.mode, PanelMode::Tab | PanelMode::Split))
        .collect();
    pages
        .iter()
        .find(|p| p.id == PAGE_PANEL_ID)
        .or(pages.first())
        .copied()
}

fn legacy_permissions(given: &Value) -> Value {
    let Value::Array(list) = given else {
        return given.clone();
    };
    let mut out = Map::new();
    for p in list {
        let name = p
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| p.to_string());
        match name.as_str() {
            "tabs" => out.insert(name, Value::String("read".into())),
            "network" => out.insert(name, Value::String("*".into())),
            _ => out.insert(name, Value::Bool(true)),
        };
    }
    Value::Object(out)
}

fn migrate_v0(mut doc: Map<String, Value>) -> Map<String, Value> {
    doc.remove("reset");
    if let Some(settings) = doc.remove("settings") {
        let mut wrapped = Map::new();
        wrapped.insert("defaults".into(), settings);
        doc.insert("settings".into(), Value::Object(wrapped));
    }
    doc
}

const MOVED_INTO_CONTRIBUTES: [&str; 6] = [
    "commands",
    "tools",
    "hooks",
    "settings",
    "programs",
    "passwordManager",
];

fn migrate_v1(mut doc: Map<String, Value>) -> Map<String, Value> {
    if doc.contains_key("contributes") || doc.contains_key("sidecar") || doc.contains_key("main") {
        return doc;
    }
    let permissions = doc.remove("permissions");
    let process = doc.remove("process");
    let page = doc.remove("page");
    let mut contributes = Map::new();
    for key in MOVED_INTO_CONTRIBUTES {
        if let Some(value) = doc.remove(key) {
            contributes.insert(key.into(), value);
        }
    }
    if let Some(page) = page {
        let panel = match page {
            Value::Object(fields) => {
                let mut panel = Map::new();
                panel.insert("id".into(), Value::String(PAGE_PANEL_ID.into()));
                panel.insert("mode".into(), Value::String("tab".into()));
                panel.extend(fields);
                Value::Object(panel)
            }
            other => other,
        };
        contributes.insert("panels".into(), Value::Array(vec![panel]));
    }
    if let Some(permissions) = permissions {
        doc.insert("permissions".into(), legacy_permissions(&permissions));
    }
    if let Some(process) = process {
        doc.insert("sidecar".into(), process);
    }
    doc.insert("contributes".into(), Value::Object(contributes));
    doc
}

pub fn v1_problem(problem: &str) -> String {
    let mut text = problem.replace("contributes.panels[0]", "page");
    text = text.replace("contributes.", "");
    if let Some(rest) = text.strip_prefix("sidecar") {
        text = format!("process{rest}");
    }
    if let Some(stem) = text.strip_suffix(" needs a main or a sidecar") {
        text = format!("{stem} needs a process");
    }
    text
}

fn host_pattern_problem(pattern: &Value) -> Option<String> {
    let Some(pattern) = pattern.as_str() else {
        return Some("isn't text".into());
    };
    if pattern == "*" {
        return None;
    }
    if pattern != pattern.to_lowercase() {
        return Some("must be lowercase".into());
    }
    if pattern
        .chars()
        .any(|c| c.is_whitespace() || "/:@?#\\[]".contains(c))
    {
        return Some("must be a bare host, like api.example.com or *.example.com, without a scheme, port or path".into());
    }
    let host_ok = |host: &str| {
        !host.is_empty()
            && host.len() <= 253
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
    };
    if let Some(rest) = pattern.strip_prefix("*.") {
        if rest.contains('*') {
            return Some("can only have one * at its start".into());
        }
        if !host_ok(rest) || rest.split('.').count() < 2 {
            return Some(
                "must put * in front of a domain with at least two parts, like *.example.com"
                    .into(),
            );
        }
        return None;
    }
    if pattern.contains('*') {
        return Some("can only have * on its own or as *. at its start".into());
    }
    (!host_ok(pattern)).then(|| "must be a host name or IP address".into())
}

fn network_of(c: &mut Check, value: Option<&Value>) -> Network {
    match value {
        None | Some(Value::Bool(false)) => Network::Off,
        Some(Value::Bool(true)) => Network::Any,
        Some(Value::String(any)) if any == "*" => Network::Any,
        Some(Value::Array(list)) if !list.is_empty() && list.len() <= limits::ALLOWED_HOSTS => {
            let mut hosts: Vec<String> = Vec::new();
            for (i, host) in list.iter().enumerate() {
                if let Some(problem) = host_pattern_problem(host) {
                    c.push(format!("permissions.network[{i}] {problem}"));
                } else if host == "*" {
                    c.push(format!(
                        "permissions.network[{i}]: use \"*\" on its own instead of in a list"
                    ));
                } else if let Some(host) = host.as_str()
                    && !hosts.iter().any(|h| h == host)
                {
                    hosts.push(host.to_owned());
                }
            }
            if hosts.is_empty() {
                Network::Off
            } else {
                Network::Hosts(hosts)
            }
        }
        Some(_) => {
            c.push(format!(
                "permissions.network must be false, \"*\" or a list of 1 to {} hosts",
                limits::ALLOWED_HOSTS
            ));
            Network::Off
        }
    }
}

fn names_of(c: &mut Check, path: &str, value: Option<&Value>, known: &[&str]) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(list) = value.as_array().filter(|l| l.len() <= known.len() * 2) else {
        c.push(format!("{path} must be a list of {}", known.join(", ")));
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for (i, name) in list.iter().enumerate() {
        match name.as_str().filter(|n| known.contains(n)) {
            None => c.push(format!("{path}[{i}] must be one of {}", known.join(", "))),
            Some(name) if !out.iter().any(|known| known == name) => out.push(name.to_owned()),
            Some(_) => {}
        }
    }
    out
}

fn state_access_of(
    c: &mut Check,
    value: Option<&Value>,
    tabs: Option<&str>,
) -> Option<StateAccess> {
    match value {
        None | Some(Value::Bool(false)) => None,
        Some(Value::Object(fields)) => {
            c.only("permissions.state", fields, &["events", "intents"]);
            let events = names_of(
                c,
                "permissions.state.events",
                fields.get("events"),
                &STATE_TOPICS,
            );
            let intents = names_of(
                c,
                "permissions.state.intents",
                fields.get("intents"),
                &STATE_INTENTS,
            );
            for topic in &events {
                if TOPICS_NEEDING_TABS.contains(&topic.as_str()) && tabs.is_none() {
                    c.push(format!("permissions.state.events: {topic} needs tabs"));
                }
            }
            if !intents.is_empty() && tabs != Some("write") {
                c.push("permissions.state.intents need tabs: write");
            }
            (!events.is_empty() || !intents.is_empty()).then_some(StateAccess { events, intents })
        }
        Some(_) => {
            c.push("permissions.state must be an object of events and intents");
            None
        }
    }
}

const PERMISSION_KEYS: [&str; 10] = [
    "tabs",
    "fullUrls",
    "activePage",
    "workspace",
    "commands",
    "storage",
    "secrets",
    "network",
    "control",
    "state",
];

fn permissions_of(c: &mut Check, value: Option<&Value>) -> Permissions {
    let mut out = Permissions::default();
    let Some(value) = value else {
        return out;
    };
    let Some(fields) = value.as_object() else {
        c.push(format!(
            "permissions must be an object of {}",
            PERMISSION_KEYS.join(", ")
        ));
        return out;
    };
    c.only("permissions", fields, &PERMISSION_KEYS);
    match fields.get("tabs") {
        None | Some(Value::Bool(false)) => {}
        Some(Value::String(t)) if t == "read" || t == "write" => out.tabs = Some(t.clone()),
        Some(_) => c.push("permissions.tabs must be read, write or false"),
    }
    let mut boolean = |key: &str, slot: &mut bool| match fields.get(key) {
        None => {}
        Some(Value::Bool(flag)) => *slot = *flag,
        Some(_) => c.push(format!("permissions.{key} must be true or false")),
    };
    boolean("fullUrls", &mut out.full_urls);
    boolean("activePage", &mut out.active_page);
    boolean("workspace", &mut out.workspace);
    boolean("commands", &mut out.commands);
    boolean("storage", &mut out.storage);
    boolean("secrets", &mut out.secrets);
    boolean("control", &mut out.control);
    out.network = network_of(c, fields.get("network"));
    out.state = state_access_of(c, fields.get("state"), out.tabs.as_deref());
    if out.full_urls && out.tabs.is_none() {
        c.push("permissions: fullUrls needs tabs");
    }
    if out.workspace && (out.tabs.as_deref() != Some("write") || !out.full_urls) {
        c.push("permissions: workspace needs tabs: write and fullUrls, since it sees and moves every tab");
    }
    out
}

fn main_of(c: &mut Check, entry: Option<&Value>, memory: Option<&Value>) -> Option<MainSpec> {
    let Some(entry) = entry else {
        if memory.is_some() {
            c.push("memoryMB only goes with main");
        }
        return None;
    };
    let file = c.plugin_file(
        "main",
        Some(entry),
        "a JavaScript file inside the plugin's folder, like dist/index.js",
        None,
    );
    if let Some(file) = &file {
        let lower = file.to_lowercase();
        if !(lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs")) {
            c.push("main must be a .js, .mjs or .cjs file");
        }
    }
    let memory_mb = c.integer(
        "memoryMB",
        memory,
        limits::MEMORY_MB,
        DEFAULT_MAIN_MB as i64,
    );
    file.map(|entry| MainSpec {
        entry,
        memory_mb: memory_mb as u32,
    })
}

fn sidecar_of(c: &mut Check, path: &str, value: Option<&Value>) -> Option<SidecarSpec> {
    let doc = c.object(path, Some(value?))?;
    c.only(path, doc, &["run", "memoryMB"]);
    let run = doc
        .get("run")
        .and_then(Value::as_array)
        .filter(|run| !run.is_empty() && run.len() <= limits::ARGV && run.iter().all(is_argument));
    let Some(run) = run else {
        c.push(format!(
            "{path}.run must be a list of 1 to {} arguments, the program first",
            limits::ARGV
        ));
        return None;
    };
    let run: Vec<String> = run
        .iter()
        .filter_map(|a| a.as_str().map(str::to_owned))
        .collect();
    let program = &run[0];
    if !program.starts_with('/') && program.contains('/') && !is_plugin_path(program) {
        c.push(format!(
            "{path}.run[0] must be a file in the plugin's folder, an absolute path or a program name"
        ));
    }
    let memory_mb = c.integer(
        &format!("{path}.memoryMB"),
        doc.get("memoryMB"),
        limits::MEMORY_MB,
        DEFAULT_SIDECAR_MB as i64,
    );
    Some(SidecarSpec {
        run,
        memory_mb: memory_mb as u32,
    })
}

fn program_of(c: &mut Check, path: &str, value: &Value) -> Option<ProgramSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(
        path,
        doc,
        &["name", "path", "afterUpdate", "example", "claim"],
    );
    let name = c.matching(
        &format!("{path}.name"),
        doc.get("name"),
        is_name,
        NAME_RULE,
        true,
    );
    let file = match doc.get("path").and_then(Value::as_str) {
        Some(file) if is_plugin_path(file) => Some(file.to_owned()),
        _ => {
            c.push(format!(
                "{path}.path must be a file in the plugin's folder, like bin/tool"
            ));
            None
        }
    };
    let (most, argv) = limits::AFTER_UPDATE;
    let after = match doc.get("afterUpdate") {
        None => Some(Vec::new()),
        Some(Value::Array(lists))
            if lists.len() <= most
                && lists.iter().all(|a| {
                    a.as_array().is_some_and(|a| {
                        !a.is_empty() && a.len() <= argv && a.iter().all(is_argument)
                    })
                }) =>
        {
            Some(
                lists
                    .iter()
                    .map(|a| {
                        a.as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default()
                    })
                    .collect(),
            )
        }
        Some(_) => {
            c.push(format!(
                "{path}.afterUpdate must be a list of at most {most} argument lists of 1 to {argv}"
            ));
            None
        }
    };
    let example = c.text(
        &format!("{path}.example"),
        doc.get("example"),
        limits::EXAMPLE,
        false,
    );
    let claim = c.flag(&format!("{path}.claim"), doc.get("claim"));
    Some(ProgramSpec {
        name: name?,
        path: file?,
        after_update: after?,
        example,
        claim,
    })
}

fn when_of(c: &mut Check, path: &str, value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.trim().is_empty() && js_len(text) <= 200 => Some(text.clone()),
        Value::String(_) => {
            c.push(format!("{path} must be 1 to 200 characters"));
            None
        }
        _ => {
            c.push(format!("{path} must be text"));
            None
        }
    }
}

const SPLIT_SIDES: [&str; 4] = ["left", "right", "top", "bottom"];
const COMMAND_KEYS: [&str; 15] = [
    "name",
    "title",
    "icon",
    "keywords",
    "when",
    "tool",
    "input",
    "open",
    "context",
    "side",
    "sideSetting",
    "path",
    "view",
    "panel",
    "handler",
];

fn action_of(
    c: &mut Check,
    path: &str,
    doc: &Map<String, Value>,
    has_main: bool,
) -> Option<CommandAction> {
    let given: Vec<&str> = ["tool", "open", "view", "panel", "handler"]
        .into_iter()
        .filter(|k| doc.contains_key(*k))
        .collect();
    if given.len() > 1 || (given.is_empty() && !has_main) {
        c.push(if given.len() > 1 {
            format!("{path} needs either tool, open, view, panel or handler, not more than one")
        } else {
            format!("{path} needs either tool (one of the plugin's tools) or open (\"tab\" or \"split\"), or a main to handle it")
        });
        return None;
    }
    let kind = given.first().copied().unwrap_or("handler");
    if kind != "open" {
        for key in ["context", "side", "sideSetting", "path"] {
            if doc.contains_key(key) {
                c.push(format!("{path}.{key} only goes with open"));
            }
        }
    }
    if kind != "tool" && kind != "open" && doc.contains_key("input") {
        c.push(format!("{path}.input only goes with tool"));
    }
    match kind {
        "tool" => {
            let tool = c.matching(
                &format!("{path}.tool"),
                doc.get("tool"),
                is_name,
                "a tool's name",
                true,
            );
            let input = match doc.get("input") {
                None => Some(Map::new()),
                Some(value) => c.object(&format!("{path}.input"), Some(value)).cloned(),
            };
            Some(CommandAction::Tool {
                tool: tool?,
                input: input?,
            })
        }
        "open" => {
            if doc.contains_key("input") {
                c.push(format!("{path}.input only goes with tool"));
            }
            let open = match doc.get("open").and_then(Value::as_str) {
                Some("tab") => Some(false),
                Some("split") => Some(true),
                _ => {
                    c.push(format!("{path}.open must be tab or split"));
                    None
                }
            };
            if doc.get("context").is_some_and(|v| !v.is_boolean()) {
                c.push(format!("{path}.context must be true or false"));
            }
            let side = match doc.get("side") {
                None => Some("right".to_owned()),
                Some(Value::String(s)) if SPLIT_SIDES.contains(&s.as_str()) => Some(s.clone()),
                Some(_) => {
                    c.push(format!("{path}.side must be left, right, top or bottom"));
                    None
                }
            };
            let side_setting = match doc.get("sideSetting") {
                None => None,
                value => c.matching(
                    &format!("{path}.sideSetting"),
                    value,
                    is_key,
                    "a row's key",
                    true,
                ),
            };
            if open != Some(true) && (doc.contains_key("side") || doc.contains_key("sideSetting")) {
                c.push(format!(
                    "{path}: side and sideSetting only go with open: split"
                ));
            }
            let page_path = match doc.get("path") {
                None => Some(String::new()),
                Some(Value::String(p)) if is_page_path(p) => Some(p.clone()),
                Some(_) => {
                    c.push(format!("{path}.path must be /like/this?q=1"));
                    None
                }
            };
            Some(CommandAction::Open {
                split: open?,
                context: doc.get("context") == Some(&Value::Bool(true)),
                side: side?,
                side_setting,
                path: page_path?,
            })
        }
        "view" => c
            .matching(
                &format!("{path}.view"),
                doc.get("view"),
                is_key,
                KEY_RULE,
                true,
            )
            .map(CommandAction::View),
        "panel" => c
            .matching(
                &format!("{path}.panel"),
                doc.get("panel"),
                is_key,
                "a panel's id",
                true,
            )
            .map(CommandAction::Panel),
        _ => {
            if doc.get("handler").is_some_and(|h| h != &Value::Bool(true)) {
                c.push(format!("{path}.handler must be true"));
            }
            Some(CommandAction::Handler)
        }
    }
}

fn command_of(c: &mut Check, path: &str, value: &Value, has_main: bool) -> Option<CommandSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &COMMAND_KEYS);
    let name = c.matching(
        &format!("{path}.name"),
        doc.get("name"),
        is_name,
        NAME_RULE,
        true,
    );
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let icon = c.symbol_of(&format!("{path}.icon"), doc.get("icon"));
    let keywords: Vec<String> = c
        .list(
            &format!("{path}.keywords"),
            doc.get("keywords"),
            limits::KEYWORDS,
        )
        .into_iter()
        .enumerate()
        .filter_map(|(i, k)| {
            c.text(
                &at_index(&format!("{path}.keywords"), i),
                Some(k),
                limits::KEYWORD,
                true,
            )
        })
        .collect();
    let when = when_of(c, &format!("{path}.when"), doc.get("when"));
    let action = action_of(c, path, doc, has_main);
    Some(CommandSpec {
        name: name?,
        title: title?,
        icon,
        keywords,
        when,
        action: action?,
    })
}

fn tool_of(c: &mut Check, path: &str, value: &Value) -> Option<ToolSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &["name", "title", "description", "timeout"]);
    let name = c.matching(
        &format!("{path}.name"),
        doc.get("name"),
        is_name,
        NAME_RULE,
        true,
    );
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let description = c
        .text(
            &format!("{path}.description"),
            doc.get("description"),
            limits::DESCRIPTION,
            false,
        )
        .unwrap_or_default();
    let timeout = c.integer(
        &format!("{path}.timeout"),
        doc.get("timeout"),
        limits::TOOL_TIMEOUT,
        30,
    );
    Some(ToolSpec {
        name: name?,
        title: title?,
        description,
        timeout,
    })
}

fn optional_number(c: &mut Check, path: &str, value: Option<&Value>) -> Option<f64> {
    let value = value?;
    match value.as_f64() {
        Some(n) if n.is_finite() && n.abs() <= 1e12 => Some(n),
        _ => {
            c.push(format!("{path} must be a number"));
            None
        }
    }
}

const ROW_KEYS: [&str; 10] = [
    "key",
    "title",
    "description",
    "type",
    "default",
    "choices",
    "min",
    "max",
    "step",
    "placeholder",
];

fn row_of(c: &mut Check, path: &str, value: &Value) -> Option<RowSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &ROW_KEYS);
    let key = c.matching(
        &format!("{path}.key"),
        doc.get("key"),
        is_key,
        KEY_RULE,
        true,
    );
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let description = c.text(
        &format!("{path}.description"),
        doc.get("description"),
        limits::DESCRIPTION,
        false,
    );
    let Some(kind) = doc
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| ["toggle", "text", "number", "choice", "secret"].contains(t))
    else {
        c.push(format!(
            "{path}.type must be toggle, text, number, choice or secret"
        ));
        return None;
    };
    for (key, types) in [
        ("choices", &["choice"][..]),
        ("min", &["number"][..]),
        ("max", &["number"][..]),
        ("step", &["number"][..]),
        ("placeholder", &["secret", "text"][..]),
    ] {
        if doc.contains_key(key) && !types.contains(&kind) {
            c.push(format!(
                "{path}.{key} only goes with type {}",
                types.join(" or ")
            ));
        }
    }
    let (key, title) = (key?, title?);
    let default = doc.get("default");
    let row_kind = match kind {
        "toggle" => match default {
            Some(Value::Bool(on)) => RowKind::Toggle(*on),
            _ => {
                c.push(format!("{path}.default must be true or false"));
                return None;
            }
        },
        "text" => match default {
            Some(Value::String(text)) if js_len(text) <= limits::ROW_TEXT && !unsafe_text(text) => {
                RowKind::Text(text.clone())
            }
            _ => {
                c.push(format!(
                    "{path}.default must be text of at most {} characters",
                    limits::ROW_TEXT
                ));
                return None;
            }
        },
        "number" => {
            let min = optional_number(c, &format!("{path}.min"), doc.get("min"));
            let max = optional_number(c, &format!("{path}.max"), doc.get("max"));
            let step = optional_number(c, &format!("{path}.step"), doc.get("step"));
            if step.is_some_and(|s| s <= 0.0) {
                c.push(format!("{path}.step must be above 0"));
                return None;
            }
            if let (Some(lo), Some(hi)) = (min, max)
                && lo > hi
            {
                c.push(format!("{path}.min must be at most its max"));
                return None;
            }
            match default.and_then(Value::as_f64) {
                Some(d)
                    if d.is_finite()
                        && d.abs() <= 1e12
                        && min.is_none_or(|m| d >= m)
                        && max.is_none_or(|m| d <= m) =>
                {
                    RowKind::Number {
                        default: d,
                        min,
                        max,
                        step,
                    }
                }
                _ => {
                    c.push(format!(
                        "{path}.default must be a number between its min and max"
                    ));
                    return None;
                }
            }
        }
        "secret" => {
            if default.is_some() {
                c.push(format!(
                    "{path}.default can't go with a secret: it's kept in the Keychain, never in plugin.json"
                ));
            }
            let placeholder = c.text(
                &format!("{path}.placeholder"),
                doc.get("placeholder"),
                limits::TITLE,
                false,
            );
            RowKind::Secret { placeholder }
        }
        _ => {
            let (least, most) = limits::CHOICES;
            let Some(list) = doc
                .get("choices")
                .and_then(Value::as_array)
                .filter(|l| l.len() >= least && l.len() <= most)
            else {
                c.push(format!(
                    "{path}.choices must be a list of {least} to {most} choices"
                ));
                return None;
            };
            let mut choices = Vec::new();
            for (i, choice) in list.iter().enumerate() {
                let p = at_index(&format!("{path}.choices"), i);
                let Some(fields) = c.object(&p, Some(choice)) else {
                    continue;
                };
                c.only(&p, fields, &["value", "title"]);
                let v = c.matching(
                    &format!("{p}.value"),
                    fields.get("value"),
                    is_key,
                    KEY_RULE,
                    true,
                );
                let t = c.text(
                    &format!("{p}.title"),
                    fields.get("title"),
                    limits::TITLE,
                    true,
                );
                if let (Some(v), Some(t)) = (v, t) {
                    choices.push((v, t));
                }
            }
            let values: Vec<String> = choices.iter().map(|(v, _)| v.clone()).collect();
            c.unique(&format!("{path}.choices"), &values, "choices");
            match default.and_then(Value::as_str) {
                Some(d) if values.iter().any(|v| v == d) => RowKind::Choice {
                    default: d.to_owned(),
                    choices,
                },
                _ => {
                    c.push(format!("{path}.default must be one of its choices' values"));
                    return None;
                }
            }
        }
    };
    Some(RowSpec {
        key,
        title,
        description,
        kind: row_kind,
    })
}

fn settings_of(c: &mut Check, path: &str, value: Option<&Value>) -> SettingsSpec {
    let Some(value) = value else {
        return SettingsSpec::default();
    };
    let Some(doc) = c.object(path, Some(value)) else {
        return SettingsSpec::default();
    };
    c.only(path, doc, &["defaults", "rows"]);
    let defaults = match doc.get("defaults") {
        None => Map::new(),
        value => c
            .object(&format!("{path}.defaults"), value)
            .cloned()
            .unwrap_or_default(),
    };
    let rows: Vec<RowSpec> = c
        .list(&format!("{path}.rows"), doc.get("rows"), limits::ROWS)
        .into_iter()
        .enumerate()
        .filter_map(|(i, r)| row_of(c, &at_index(&format!("{path}.rows"), i), r))
        .collect();
    let keys: Vec<String> = rows.iter().map(|r| r.key.clone()).collect();
    c.unique(&format!("{path}.rows"), &keys, "rows");
    SettingsSpec { defaults, rows }
}

fn menu_item_of(c: &mut Check, path: &str, value: &Value) -> Option<MenuContribution> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &["command", "title", "icon", "when"]);
    let command = c.matching(
        &format!("{path}.command"),
        doc.get("command"),
        is_name,
        "one of the plugin's commands",
        true,
    );
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        false,
    );
    let icon = doc
        .get("icon")
        .map(|i| c.symbol_of(&format!("{path}.icon"), Some(i)));
    let when = when_of(c, &format!("{path}.when"), doc.get("when"));
    Some(MenuContribution {
        command: command?,
        title,
        icon,
        when,
    })
}

fn toolbar_item_of(c: &mut Check, path: &str, value: &Value) -> Option<ToolbarItem> {
    let doc = c.object(path, Some(value))?;
    c.only(
        path,
        doc,
        &["id", "title", "icon", "command", "view", "tooltip"],
    );
    let id = c.matching(&format!("{path}.id"), doc.get("id"), is_key, KEY_RULE, true);
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let icon = c.matching(
        &format!("{path}.icon"),
        doc.get("icon"),
        is_symbol,
        SYMBOL_RULE,
        true,
    );
    let tooltip = c.text(
        &format!("{path}.tooltip"),
        doc.get("tooltip"),
        limits::TOOLTIP,
        false,
    );
    if doc.contains_key("command") == doc.contains_key("view") {
        c.push(format!("{path} needs either command or view"));
    }
    let command = match doc.get("command") {
        None => None,
        value => c.matching(
            &format!("{path}.command"),
            value,
            is_name,
            "one of the plugin's commands",
            true,
        ),
    };
    let view = match doc.get("view") {
        None => None,
        value => c.matching(&format!("{path}.view"), value, is_key, KEY_RULE, true),
    };
    if command.is_none() && view.is_none() {
        return None;
    }
    Some(ToolbarItem {
        id: id?,
        title: title?,
        icon: icon?,
        command,
        view,
        tooltip,
    })
}

fn sidebar_view_of(c: &mut Check, path: &str, value: &Value) -> Option<SidebarView> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &["id", "title", "icon"]);
    let id = c.matching(&format!("{path}.id"), doc.get("id"), is_key, KEY_RULE, true);
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::PAGE_TITLE,
        true,
    );
    let icon = c.symbol_of(&format!("{path}.icon"), doc.get("icon"));
    Some(SidebarView {
        id: id?,
        title: title?,
        icon,
    })
}

fn panel_of(c: &mut Check, path: &str, value: &Value) -> Option<PanelSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(
        path,
        doc,
        &[
            "id",
            "title",
            "icon",
            "mode",
            "file",
            "view",
            "retainContext",
            "side",
            "served",
        ],
    );
    if doc.contains_key("served") {
        c.push(format!("{path}.served is gone: a page is static files from the plugin's folder (page.file), and it talks to its helper with window.ardia.send"));
        return None;
    }
    let id = c.matching(&format!("{path}.id"), doc.get("id"), is_key, KEY_RULE, true);
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::PAGE_TITLE,
        true,
    );
    let icon = c.symbol_of(&format!("{path}.icon"), doc.get("icon"));
    let mode = match doc.get("mode").and_then(Value::as_str) {
        Some("sidecar") => Some(PanelMode::Sidecar),
        Some("tab") => Some(PanelMode::Tab),
        Some("split") => Some(PanelMode::Split),
        _ => {
            c.push(format!("{path}.mode must be sidecar, tab, split"));
            None
        }
    };
    let retain_context = c.flag(&format!("{path}.retainContext"), doc.get("retainContext"));
    if doc.contains_key("file") && doc.contains_key("view") {
        c.push(format!("{path} takes a file or a view, not both"));
    }
    if !doc.contains_key("file") && !doc.contains_key("view") {
        c.push(format!("{path}.file must be a path inside the plugin's folder, like page/index.html, or the panel needs a view"));
        return None;
    }
    let file = match doc.get("file") {
        None => None,
        value => c.plugin_file(
            &format!("{path}.file"),
            value,
            "a path inside the plugin's folder, like page/index.html",
            None,
        ),
    };
    let view = match doc.get("view") {
        None => None,
        value => c.matching(&format!("{path}.view"), value, is_key, KEY_RULE, true),
    };
    if doc.contains_key("side") && mode != Some(PanelMode::Split) {
        c.push(format!("{path}.side only goes with mode split"));
    }
    let side = match doc.get("side") {
        None => None,
        Some(Value::String(s)) if SPLIT_SIDES.contains(&s.as_str()) => Some(s.clone()),
        Some(_) => {
            c.push(format!("{path}.side must be left, right, top or bottom"));
            None
        }
    };
    if file.is_none() && view.is_none() {
        return None;
    }
    Some(PanelSpec {
        id: id?,
        title: title?,
        icon,
        mode: mode?,
        file,
        view,
        retain_context,
        side,
    })
}

fn omnibox_of(c: &mut Check, path: &str, value: &Value) -> Option<OmniboxSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &["id", "title", "keyword", "global"]);
    let id = c.matching(&format!("{path}.id"), doc.get("id"), is_key, KEY_RULE, true);
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let keyword = c.matching(
        &format!("{path}.keyword"),
        doc.get("keyword"),
        is_keyword,
        "1 to 32 letters, digits, - and _",
        false,
    );
    let global = c.flag(&format!("{path}.global"), doc.get("global"));
    if keyword.is_none() && !global {
        c.push(format!(
            "{path} needs a keyword or global: true, or it never shows"
        ));
    }
    if keyword.is_some() && global {
        c.push(format!("{path} takes a keyword or global: true, not both"));
    }
    Some(OmniboxSpec {
        id: id?,
        title: title?,
        keyword,
        global,
    })
}

fn theme_of(c: &mut Check, path: &str, value: &Value) -> Option<ThemeSpec> {
    let doc = c.object(path, Some(value))?;
    c.only(path, doc, &["id", "title", "file"]);
    let id = c.matching(&format!("{path}.id"), doc.get("id"), is_key, KEY_RULE, true);
    let title = c.text(
        &format!("{path}.title"),
        doc.get("title"),
        limits::TITLE,
        true,
    );
    let file = c.plugin_file(
        &format!("{path}.file"),
        doc.get("file"),
        "a .json file inside the plugin's folder, like themes/dusk.json",
        Some(".json"),
    );
    Some(ThemeSpec {
        id: id?,
        title: title?,
        file: file?,
    })
}

fn site_switches_of(c: &mut Check, value: Option<&Value>) -> Vec<SiteSwitchSpec> {
    let path = "contributes.siteSwitches";
    let out: Vec<SiteSwitchSpec> = c
        .list(path, value, limits::SITE_SWITCHES)
        .into_iter()
        .enumerate()
        .filter_map(|(i, raw)| {
            let at_ = at_index(path, i);
            let doc = c.object(&at_, Some(raw))?;
            c.only(&at_, doc, &["key", "title", "icon"]);
            let key = c.matching(
                &format!("{at_}.key"),
                doc.get("key"),
                is_key,
                KEY_RULE,
                true,
            );
            let title = c.text(
                &format!("{at_}.title"),
                doc.get("title"),
                limits::SWITCH_TITLE,
                true,
            );
            let icon = c.symbol_of(&format!("{at_}.icon"), doc.get("icon"));
            Some(SiteSwitchSpec {
                key: key?,
                title: title?,
                icon,
            })
        })
        .collect();
    let keys: Vec<String> = out.iter().map(|s| s.key.clone()).collect();
    c.unique(path, &keys, "switches");
    out
}

fn page_bar_of(
    c: &mut Check,
    value: Option<&Value>,
    switches: &[SiteSwitchSpec],
    rows: &[RowSpec],
) -> Option<PageBarSpec> {
    let path = "contributes.pageBar";
    let doc = c.object(path, Some(value?))?;
    c.only(path, doc, &["look", "when", "buttons"]);
    let look_ok = doc.get("look").and_then(Value::as_str) == Some("stripes");
    if !look_ok {
        c.push(format!("{path}.look must be stripes"));
    }
    let empty = Map::new();
    let when = c
        .object(&format!("{path}.when"), doc.get("when"))
        .unwrap_or(&empty)
        .clone();
    c.only(
        &format!("{path}.when"),
        &when,
        &["siteSwitch", "localAddresses"],
    );
    let site_switch = when
        .get("siteSwitch")
        .and_then(Value::as_str)
        .filter(|k| switches.iter().any(|s| s.key == *k))
        .map(str::to_owned);
    if site_switch.is_none() {
        c.push(format!(
            "{path}.when.siteSwitch must name one of this plugin's siteSwitches"
        ));
    }
    let local_addresses = match when.get("localAddresses") {
        None => None,
        Some(Value::String(k))
            if rows
                .iter()
                .any(|r| r.key == *k && r.type_name() == "toggle") =>
        {
            Some(k.clone())
        }
        Some(_) => {
            c.push(format!(
                "{path}.when.localAddresses must name one of this plugin's toggle rows"
            ));
            None
        }
    };
    let buttons_path = format!("{path}.buttons");
    let mut buttons: Vec<String> = Vec::new();
    match doc.get("buttons").and_then(Value::as_array) {
        Some(list) if !list.is_empty() && list.len() <= limits::PAGE_BAR_BUTTONS => {
            for (i, b) in list.iter().enumerate() {
                match b.as_str() {
                    Some("|") => buttons.push("|".into()),
                    Some(action) if HOST_ACTIONS.iter().any(|(n, _)| *n == action) => {
                        if buttons.iter().any(|known| known == action) {
                            c.push(format!("{buttons_path} has {action} twice"));
                        } else {
                            buttons.push(action.to_owned());
                        }
                    }
                    _ => c.push(format!(
                        "{} must be | or one of {}",
                        at_index(&buttons_path, i),
                        HOST_ACTIONS
                            .iter()
                            .map(|(n, _)| *n)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )),
                }
            }
        }
        _ => c.push(format!(
            "{buttons_path} must be a list of 1 to {}",
            limits::PAGE_BAR_BUTTONS
        )),
    }
    let has_action = buttons.iter().any(|b| b != "|");
    if !buttons.is_empty() && !has_action {
        c.push(format!(
            "{buttons_path} needs at least one action besides |"
        ));
    }
    (look_ok && has_action).then_some(())?;
    Some(PageBarSpec {
        site_switch: site_switch?,
        local_addresses,
        buttons,
    })
}

fn password_manager_of(c: &mut Check, value: Option<&Value>) -> Option<PasswordManagerSpec> {
    let value = value?;
    let path = "contributes.passwordManager";
    let Some(doc) = value.as_object() else {
        c.push(format!("{path} must be an object"));
        return None;
    };
    c.only(
        path,
        doc,
        &["fill", "fields", "verificationCodeSetup", "passkeys"],
    );
    let fill = doc.get("fill").and_then(Value::as_str) == Some("system");
    if !fill {
        if doc.get("fill").and_then(Value::as_str) == Some("tool") {
            c.push(format!("{path}.fill: tool isn't available yet; use system"));
        } else {
            c.push(format!("{path}.fill must be system"));
        }
    }
    let mut fields: Vec<String> = Vec::new();
    match doc
        .get("fields")
        .and_then(Value::as_array)
        .filter(|l| !l.is_empty() && l.len() <= 2)
    {
        Some(list) => {
            for (i, f) in list.iter().enumerate() {
                match f.as_str().filter(|f| *f == "login" || *f == "oneTimeCode") {
                    None => c.push(format!("{path}.fields[{i}] must be login or oneTimeCode")),
                    Some(f) if fields.iter().any(|k| k == f) => {
                        c.push(format!("{path}.fields has {f} twice"))
                    }
                    Some(f) => fields.push(f.to_owned()),
                }
            }
        }
        None => c.push(format!(
            "{path}.fields must be a list of 1 to 2 of login, oneTimeCode"
        )),
    }
    let system_only = |c: &mut Check, key: &str| match doc.get(key) {
        None => false,
        Some(Value::String(s)) if s == "system" => true,
        Some(_) => {
            c.push(format!("{path}.{key} must be system"));
            false
        }
    };
    let verification_code_setup = system_only(c, "verificationCodeSetup");
    let passkeys = system_only(c, "passkeys");
    (fill && !fields.is_empty()).then_some(PasswordManagerSpec {
        fields,
        verification_code_setup,
        passkeys,
    })
}

const CONTRIBUTES_KEYS: [&str; 14] = [
    "commands",
    "tools",
    "hooks",
    "settings",
    "programs",
    "passwordManager",
    "menus",
    "toolbar",
    "sidebarViews",
    "panels",
    "omnibox",
    "themes",
    "siteSwitches",
    "pageBar",
];

fn parsed<T>(
    c: &mut Check,
    key: &str,
    value: Option<&Value>,
    max: usize,
    read: &dyn Fn(&mut Check, &str, &Value) -> Option<T>,
    id: fn(&T) -> String,
    what: &str,
) -> Vec<T> {
    let path = format!("contributes.{key}");
    let out: Vec<T> = c
        .list(&path, value, max)
        .into_iter()
        .enumerate()
        .filter_map(|(i, v)| read(c, &at_index(&path, i), v))
        .collect();
    let ids: Vec<String> = out.iter().map(id).collect();
    c.unique(&path, &ids, what);
    out
}

fn contributes_of(c: &mut Check, value: Option<&Value>, has_main: bool) -> Contributions {
    let empty = Map::new();
    let doc = match value {
        None => empty,
        value => c.object("contributes", value).cloned().unwrap_or_default(),
    };
    c.only("contributes", &doc, &CONTRIBUTES_KEYS);
    let password_manager = password_manager_of(c, doc.get("passwordManager"));
    let settings = settings_of(c, "contributes.settings", doc.get("settings"));
    let site_switches = site_switches_of(c, doc.get("siteSwitches"));
    let menus = doc.get("menus");
    let mut menus_tab = Vec::new();
    let mut menus_group = Vec::new();
    if let Some(menus) = menus
        && let Some(fields) = c.object("contributes.menus", Some(menus)).cloned()
    {
        c.only("contributes.menus", &fields, &["tab", "group"]);
        for (slot, out) in [("tab", &mut menus_tab), ("group", &mut menus_group)] {
            let path = format!("contributes.menus.{slot}");
            for (i, m) in c
                .list(&path, fields.get(slot), limits::MENU_ITEMS)
                .into_iter()
                .enumerate()
            {
                if let Some(item) = menu_item_of(c, &at_index(&path, i), m) {
                    out.push(item);
                }
            }
        }
    }
    let hooks: Vec<String> = c
        .list("contributes.hooks", doc.get("hooks"), limits::HOOKS)
        .into_iter()
        .enumerate()
        .filter_map(|(i, h)| match h.as_str().filter(|h| !h.is_empty()) {
            Some(h) => Some(h.to_owned()),
            None => {
                c.push(format!(
                    "{} must be an event name",
                    at_index("contributes.hooks", i)
                ));
                None
            }
        })
        .collect();
    let page_bar = page_bar_of(c, doc.get("pageBar"), &site_switches, &settings.rows);
    Contributions {
        commands: parsed(
            c,
            "commands",
            doc.get("commands"),
            limits::COMMANDS,
            &|c, p, v| command_of(c, p, v, has_main),
            |x| x.name.clone(),
            "commands",
        ),
        tools: parsed(
            c,
            "tools",
            doc.get("tools"),
            limits::TOOLS,
            &tool_of,
            |t| t.name.clone(),
            "tools",
        ),
        hooks,
        settings,
        programs: parsed(
            c,
            "programs",
            doc.get("programs"),
            limits::PROGRAMS,
            &program_of,
            |p| p.name.clone(),
            "programs",
        ),
        password_manager,
        menus_tab,
        menus_group,
        toolbar: parsed(
            c,
            "toolbar",
            doc.get("toolbar"),
            limits::TOOLBAR,
            &toolbar_item_of,
            |t| t.id.clone(),
            "toolbar items",
        ),
        sidebar_views: parsed(
            c,
            "sidebarViews",
            doc.get("sidebarViews"),
            limits::SIDEBAR_VIEWS,
            &sidebar_view_of,
            |v| v.id.clone(),
            "sidebar views",
        ),
        panels: parsed(
            c,
            "panels",
            doc.get("panels"),
            limits::PANELS,
            &panel_of,
            |p| p.id.clone(),
            "panels",
        ),
        omnibox: parsed(
            c,
            "omnibox",
            doc.get("omnibox"),
            limits::OMNIBOX,
            &omnibox_of,
            |o| o.id.clone(),
            "omnibox providers",
        ),
        themes: parsed(
            c,
            "themes",
            doc.get("themes"),
            limits::THEMES,
            &theme_of,
            |t| t.id.clone(),
            "themes",
        ),
        site_switches,
        page_bar,
    }
}

fn activation_events_of(c: &mut Check, value: Option<&Value>) -> Option<Vec<String>> {
    let value = value?;
    let list = c.list("activationEvents", Some(value), limits::ACTIVATION_EVENTS);
    let prefixes = [
        "onCommand",
        "onView",
        "onPanel",
        "onToolbar",
        "onOmnibox",
        "onMenu",
        "onEvent",
        "onUrl",
    ];
    let mut out = Vec::new();
    for (i, e) in list.into_iter().enumerate() {
        let ok = e.as_str().filter(|e| {
            *e == "*"
                || *e == "onStartupFinished"
                || e.split_once(':').is_some_and(|(prefix, arg)| {
                    prefixes.contains(&prefix)
                        && !arg.is_empty()
                        && arg.len() <= 253
                        && !arg.contains(char::is_whitespace)
                })
        });
        match ok {
            Some(e) => out.push(e.to_owned()),
            None => c.push(format!(
                "activationEvents[{i}] must be *, onStartupFinished or on<Kind>:<id>"
            )),
        }
    }
    Some(out)
}

fn derived_activation_events(k: &Contributions, main: bool, sidecar: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |e: String| {
        if !out.contains(&e) {
            out.push(e);
        }
    };
    if !k.hooks.is_empty() || (sidecar && !main) {
        add("onStartupFinished".into());
    }
    k.commands
        .iter()
        .for_each(|x| add(format!("onCommand:{}", x.name)));
    k.sidebar_views
        .iter()
        .for_each(|v| add(format!("onView:{}", v.id)));
    k.panels
        .iter()
        .filter(|p| p.view.is_some())
        .for_each(|p| add(format!("onPanel:{}", p.id)));
    k.toolbar
        .iter()
        .for_each(|t| add(format!("onToolbar:{}", t.id)));
    k.omnibox
        .iter()
        .for_each(|o| add(format!("onOmnibox:{}", o.id)));
    if !k.menus_tab.is_empty() {
        add("onMenu:tab".into());
    }
    if !k.menus_group.is_empty() {
        add("onMenu:group".into());
    }
    out
}

const TOP_KEYS: [&str; 19] = [
    "$schema",
    "manifest",
    "name",
    "title",
    "description",
    "version",
    "requires",
    "icon",
    "main",
    "memoryMB",
    "sidecar",
    "activationEvents",
    "permissions",
    "contributes",
    "alwaysOn",
    "official",
    "autoInstall",
    "keywords",
    "telemetry",
];

fn check_manifest(raw: &Map<String, Value>, declared: i64) -> Result<PluginManifest, Vec<String>> {
    let mut c = Check::default();
    c.only("", raw, &TOP_KEYS);
    let name = c.matching("name", raw.get("name"), is_name, NAME_RULE, true);
    let title = c.text(
        "title",
        raw.get("title").or(raw.get("name")),
        limits::TITLE,
        true,
    );
    let description = c
        .text(
            "description",
            raw.get("description"),
            limits::DESCRIPTION,
            false,
        )
        .unwrap_or_default();
    let version = c.matching(
        "version",
        raw.get("version"),
        is_version,
        "MAJOR.MINOR.PATCH",
        false,
    );
    let requires = c.matching(
        "requires",
        raw.get("requires"),
        is_version,
        "an Ardia version, MAJOR.MINOR.PATCH",
        false,
    );
    let icon = c.matching("icon", raw.get("icon"), is_symbol, SYMBOL_RULE, false);
    let keywords: Vec<String> = {
        let given: Vec<Option<String>> = c
            .list("keywords", raw.get("keywords"), limits::PLUGIN_KEYWORDS)
            .into_iter()
            .enumerate()
            .map(|(i, k)| c.text(&format!("keywords[{i}]"), Some(k), limits::KEYWORD, true))
            .collect();
        let mut out: Vec<String> = Vec::new();
        for k in given.into_iter().flatten() {
            if !out.contains(&k) {
                out.push(k);
            }
        }
        out
    };
    let telemetry = raw.get("telemetry").and_then(|value| {
        let doc = c.object("telemetry", Some(value))?.clone();
        c.only("telemetry", &doc, &["title", "items"]);
        let title = c.text("telemetry.title", doc.get("title"), limits::TITLE, true);
        let list = c.list("telemetry.items", doc.get("items"), limits::TELEMETRY_ITEMS);
        if list.is_empty() {
            c.push(format!(
                "telemetry.items must be a list of 1 to {}",
                limits::TELEMETRY_ITEMS
            ));
        }
        let items: Vec<Option<String>> = list
            .iter()
            .enumerate()
            .map(|(i, item)| {
                c.text(
                    &format!("telemetry.items[{i}]"),
                    Some(item),
                    limits::TELEMETRY_ITEM,
                    true,
                )
            })
            .collect();
        if list.is_empty() || items.iter().any(Option::is_none) {
            return None;
        }
        Some(TelemetryDisclosure {
            title: title?,
            items: items.into_iter().flatten().collect(),
        })
    });
    let permissions = permissions_of(&mut c, raw.get("permissions"));
    let main = main_of(&mut c, raw.get("main"), raw.get("memoryMB"));
    let sidecar = sidecar_of(&mut c, "sidecar", raw.get("sidecar"));
    let runtime_main = main.is_some() || raw.contains_key("main");
    let runtime_sidecar = sidecar.is_some() || raw.contains_key("sidecar");
    if runtime_main && runtime_sidecar {
        c.push("a plugin can declare main or sidecar, not both");
    }
    let contributes = contributes_of(&mut c, raw.get("contributes"), runtime_main);
    let given = activation_events_of(&mut c, raw.get("activationEvents"));
    if given.is_some() && !runtime_main {
        c.push("activationEvents only go with a main");
    }
    let mut built_in = [false; 3];
    for (slot, key) in built_in
        .iter_mut()
        .zip(["alwaysOn", "official", "autoInstall"])
    {
        match raw.get(key) {
            None => {}
            Some(Value::Bool(true)) => *slot = true,
            Some(_) => c.push(format!("{key} must be true")),
        }
    }
    let page = page_panel_of(&contributes.panels).and_then(|panel| {
        panel.file.as_ref().map(|file| PageSpec {
            title: panel.title.clone(),
            icon: panel.icon.clone(),
            file: file.clone(),
        })
    });
    if declared < MANIFEST_VERSION {
        for key in ["keywords", "telemetry"] {
            if raw.contains_key(key) {
                c.push(format!("{key} needs manifest {MANIFEST_VERSION}"));
            }
        }
        for (i, p) in contributes.programs.iter().enumerate() {
            if p.example.is_some() {
                c.push(format!(
                    "programs[{i}].example needs manifest {MANIFEST_VERSION}"
                ));
            }
            if p.claim {
                c.push(format!(
                    "programs[{i}].claim needs manifest {MANIFEST_VERSION}"
                ));
            }
        }
    }
    let k = &contributes;
    for (i, x) in k.commands.iter().enumerate() {
        let path = format!("contributes.commands[{i}]");
        match &x.action {
            CommandAction::Tool { tool, .. } => {
                if !k.tools.iter().any(|t| &t.name == tool) {
                    c.push(format!(
                        "{path}.tool: {tool} isn't one of this plugin's tools"
                    ));
                }
            }
            CommandAction::Open {
                context,
                side_setting,
                ..
            } => {
                if page.is_none() {
                    c.push(format!("{path}.open needs a page"));
                }
                if *context && permissions.tabs.is_none() {
                    c.push(format!("{path}.context needs the tabs permission"));
                }
                if let Some(setting) = side_setting {
                    let ok = k.settings.rows.iter().find(|r| &r.key == setting).is_some_and(|r| {
                        matches!(&r.kind, RowKind::Choice { choices, .. } if choices.iter().all(|(v, _)| SPLIT_SIDES.contains(&v.as_str())))
                    });
                    if !ok {
                        c.push(format!("{path}.sideSetting must name a choice row whose values are left, right, top or bottom"));
                    }
                }
            }
            CommandAction::Panel(panel) => {
                if !k.panels.iter().any(|p| &p.id == panel) {
                    c.push(format!(
                        "{path}.panel: {panel} isn't one of this plugin's panels"
                    ));
                }
            }
            CommandAction::View(_) | CommandAction::Handler => {
                if !runtime_main {
                    let which = if matches!(x.action, CommandAction::View(_)) {
                        "view"
                    } else {
                        "handler"
                    };
                    c.push(format!("{path}.{which} needs a main"));
                }
            }
        }
    }
    let names: Vec<&str> = k.commands.iter().map(|x| x.name.as_str()).collect();
    for (slot, items) in [("tab", &k.menus_tab), ("group", &k.menus_group)] {
        for (i, m) in items.iter().enumerate() {
            if !names.contains(&m.command.as_str()) {
                c.push(format!(
                    "contributes.menus.{slot}[{i}].command: {} isn't one of this plugin's commands",
                    m.command
                ));
            }
        }
    }
    for (i, t) in k.toolbar.iter().enumerate() {
        if let Some(cmd) = &t.command
            && !names.contains(&cmd.as_str())
        {
            c.push(format!(
                "contributes.toolbar[{i}].command: {cmd} isn't one of this plugin's commands"
            ));
        }
        if t.view.is_some() && !runtime_main {
            c.push(format!("contributes.toolbar[{i}].view needs a main"));
        }
    }
    for (i, p) in k.panels.iter().enumerate() {
        if p.view.is_some() && !runtime_main {
            c.push(format!("contributes.panels[{i}].view needs a main"));
        }
    }
    for (what, used) in [
        ("sidebarViews", !k.sidebar_views.is_empty()),
        ("omnibox", !k.omnibox.is_empty()),
    ] {
        if used && !runtime_main {
            c.push(format!("contributes.{what} needs a main"));
        }
    }
    for (what, used) in [
        (
            "tool commands",
            k.commands
                .iter()
                .any(|x| matches!(x.action, CommandAction::Tool { .. })),
        ),
        ("tools", !k.tools.is_empty()),
        ("hooks", !k.hooks.is_empty()),
    ] {
        if used && !runtime_main && !runtime_sidecar {
            c.push(format!("{what} needs a main or a sidecar"));
        }
    }
    if k.settings.rows.iter().any(|r| r.type_name() == "secret") && !permissions.secrets {
        c.push("contributes.settings.rows: a secret row needs the secrets permission");
    }
    if let Some(name) = &name
        && k.panels.iter().any(|p| p.file.is_some())
        && RESERVED_PAGE_NAMES.contains(&name.as_str())
    {
        c.push(format!("name: {name} is one of Ardia's own pages (ardia://{name}), so a plugin with a page can't use it"));
    }
    if sidecar.is_some() && matches!(permissions.network, Network::Hosts(_)) {
        c.push("permissions.network: a sidecar can only have \"*\" or false, since Ardia can't hold a program to a list of hosts");
    }
    if !c.problems.is_empty() {
        return Err(c.problems);
    }
    let (Some(name), Some(title)) = (name, title) else {
        return Err(c.problems);
    };
    let activation_events = given
        .unwrap_or_else(|| derived_activation_events(&contributes, runtime_main, runtime_sidecar));
    Ok(PluginManifest {
        declared_manifest: declared,
        name,
        title,
        description,
        version,
        requires,
        icon,
        keywords,
        telemetry,
        permissions,
        main,
        sidecar,
        activation_events,
        contributes,
        always_on: built_in[0],
        official: built_in[1],
        auto_install: built_in[2],
        page,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct ManifestRead {
    pub manifest: Option<PluginManifest>,
    pub problems: Vec<String>,
    pub newer: bool,
}

pub fn read_manifest(text: &str) -> ManifestRead {
    let fail = |problem: String| ManifestRead {
        manifest: None,
        problems: vec![problem],
        newer: false,
    };
    let doc: Value = match serde_json::from_str(text) {
        Ok(doc) => doc,
        Err(error) => return fail(format!("{MANIFEST_FILE} isn't valid JSON ({error})")),
    };
    let Value::Object(mut doc) = doc else {
        return fail(format!("{MANIFEST_FILE} must be an object"));
    };
    let declared = match doc.get("manifest") {
        None => 0,
        Some(value) => match value.as_f64() {
            Some(n) if n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n) => n as i64,
            _ => return fail("manifest must be a whole number, the manifest's version".into()),
        },
    };
    if declared > MANIFEST_VERSION {
        return ManifestRead {
            manifest: None,
            problems: vec![format!(
                "manifest {declared} needs a newer Ardia (this one reads up to {MANIFEST_VERSION})"
            )],
            newer: true,
        };
    }
    if declared < 1 {
        doc = migrate_v0(doc);
    }
    if declared < 2 {
        doc = migrate_v1(doc);
    }
    doc.insert("manifest".into(), serde_json::json!(MANIFEST_VERSION));
    let legacy = declared < MANIFEST_VERSION;
    match check_manifest(&doc, declared) {
        Ok(manifest) => ManifestRead {
            manifest: Some(manifest),
            problems: Vec::new(),
            newer: false,
        },
        Err(problems) => ManifestRead {
            manifest: None,
            problems: problems
                .into_iter()
                .map(|p| {
                    format!(
                        "{MANIFEST_FILE}: {}",
                        if legacy { v1_problem(&p) } else { p }
                    )
                })
                .collect(),
            newer: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_v2_main_plugin_with_contributions() {
        let read = read_manifest(
            r#"{"manifest":2,"name":"notes","title":"Notes","icon":"note.text","main":"dist/index.js",
            "permissions":{"tabs":"read","network":["api.notes.app"],"storage":true},
            "contributes":{"toolbar":[{"id":"quick","title":"Quick","icon":"star","view":"quick"}],
              "sidebarViews":[{"id":"list","title":"Notes"}],
              "panels":[{"id":"side","title":"Side","mode":"sidecar","view":"side"}],
              "siteSwitches":[{"key":"dev","title":"Dev","icon":"hammer"}],
              "pageBar":{"look":"stripes","when":{"siteSwitch":"dev"},"buttons":["siteControls","|","console","address"]},
              "commands":[{"name":"open","title":"Open Notes","view":"quick"}]}}"#,
        );
        assert!(read.problems.is_empty(), "{:?}", read.problems);
        let m = read.manifest.unwrap();
        assert_eq!(m.main.as_ref().unwrap().memory_mb, 256);
        assert_eq!(
            m.permissions.network,
            Network::Hosts(vec!["api.notes.app".into()])
        );
        assert_eq!(m.view_ids(), vec!["list", "side", "quick"]);
        assert!(m.activation_events.contains(&"onToolbar:quick".to_owned()));
        assert!(!m.runs_eagerly());
        assert_eq!(m.contributes.page_bar.unwrap().buttons.len(), 4);
    }

    #[test]
    fn migrates_a_v1_sidecar_with_a_page() {
        let read = read_manifest(
            r#"{"manifest":1,"name":"agent-inbox","title":"Agent Inbox","version":"1.2.0","permissions":["commands"],
            "page":{"title":"Agent Inbox","icon":"tray.full","file":"page/index.html"},
            "process":{"run":["/usr/bin/python3","helper.py"],"memoryMB":128},
            "commands":[{"name":"open","title":"Open Agent Inbox","icon":"tray.full","open":"tab"}],
            "tools":[{"name":"post","title":"Post","timeout":10}],
            "programs":[{"name":"ardia-inbox","path":"bin/ardia-inbox"}]}"#,
        );
        assert!(read.problems.is_empty(), "{:?}", read.problems);
        let m = read.manifest.unwrap();
        assert!(m.permissions.commands);
        assert_eq!(m.sidecar.as_ref().unwrap().run[0], "/usr/bin/python3");
        assert_eq!(m.page.as_ref().unwrap().file, "page/index.html");
        assert!(m.runs_eagerly());
        assert_eq!(m.activation_events[0], "onStartupFinished");
    }

    #[test]
    fn refuses_bad_manifests_with_their_problems() {
        let read = read_manifest(
            r#"{"manifest":2,"name":"Bad Name","main":"x.txt","sidecar":{"run":["a"]}}"#,
        );
        assert!(read.manifest.is_none());
        let problems = read.problems.join("\n");
        assert!(problems.contains("plugin.json: name must be 1 to 40 lowercase"));
        assert!(problems.contains("main must be a .js, .mjs or .cjs file"));
        assert!(problems.contains("a plugin can declare main or sidecar, not both"));
        assert!(read_manifest(r#"{"manifest":3}"#).newer);
        assert!(read_manifest("[]").problems[0].contains("must be an object"));
        let v1 = read_manifest(r#"{"manifest":1,"name":"x","page":{"title":"T","icon":"star"}}"#);
        assert!(
            v1.problems
                .iter()
                .any(|p| p.starts_with("plugin.json: page.file")),
            "{:?}",
            v1.problems
        );
    }
}
