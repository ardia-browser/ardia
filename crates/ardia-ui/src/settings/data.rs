use ardia_state::ProfileId;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SettingsQuery {
    Passwords(ProfileId),
    NeverSaved(ProfileId),
    PasswordsUnlocked(ProfileId),
    Addresses(ProfileId),
    Cards(ProfileId),
    SiteOrigins(ProfileId),
    Site(ProfileId, String),
    Zooms(ProfileId),
    Extensions(ProfileId),
    HiddenElements(ProfileId),
    SavedInstallId,
    ControlApprovals,
}

impl SettingsQuery {
    pub fn profile(&self) -> Option<&ProfileId> {
        Some(match self {
            SettingsQuery::Passwords(p)
            | SettingsQuery::NeverSaved(p)
            | SettingsQuery::PasswordsUnlocked(p)
            | SettingsQuery::Addresses(p)
            | SettingsQuery::Cards(p)
            | SettingsQuery::SiteOrigins(p)
            | SettingsQuery::Site(p, _)
            | SettingsQuery::Zooms(p)
            | SettingsQuery::Extensions(p)
            | SettingsQuery::HiddenElements(p) => p,
            SettingsQuery::SavedInstallId | SettingsQuery::ControlApprovals => return None,
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SettingsCall {
    UnlockPasswords(ProfileId),
    RevealPassword {
        profile: ProfileId,
        origin: String,
        username: String,
    },
    UpdatePassword {
        profile: ProfileId,
        origin: String,
        username: String,
        new_username: Option<String>,
        password: Secret,
    },
    RemovePassword {
        profile: ProfileId,
        origin: String,
        username: String,
    },
    AllowSaving {
        profile: ProfileId,
        origin: String,
    },
    ImportPasswords(ProfileId),
    ExportPasswords(ProfileId),
    SaveAddress {
        profile: ProfileId,
        address: Value,
    },
    SaveCard {
        profile: ProfileId,
        card: Value,
        number: Option<Secret>,
    },
    RemoveAutofill {
        profile: ProfileId,
        id: String,
    },
    CardNumber {
        profile: ProfileId,
        id: String,
    },
    SetSiteSetting {
        profile: ProfileId,
        origin: String,
        kind: String,
        value: String,
    },
    ResetSite {
        profile: ProfileId,
        origin: String,
    },
    ClearSiteData {
        profile: ProfileId,
        origin: String,
    },
    SetZoom {
        profile: ProfileId,
        host: String,
        level: f64,
    },
    SetExtensionEnabled {
        profile: ProfileId,
        id: String,
        enabled: bool,
    },
    ConfigureExtension {
        profile: ProfileId,
        id: String,
        options: Value,
    },
    ReloadExtension {
        profile: ProfileId,
        id: String,
    },
    UninstallExtension {
        profile: ProfileId,
        id: String,
    },
    ExportBookmarks(ProfileId),
    ResetAnonymousId,
    ViewMyData,
    RevokeApproval(String),
    AddExtensionFromLink(ProfileId),
    ChooseUnpackedExtension(ProfileId),
    InstallUnpackedExtension {
        profile: ProfileId,
        path: String,
    },
    RestoreHiddenElements {
        profile: ProfileId,
        filters: Vec<String>,
    },
}

impl SettingsCall {
    pub fn profile(&self) -> Option<&ProfileId> {
        Some(match self {
            SettingsCall::UnlockPasswords(p)
            | SettingsCall::ImportPasswords(p)
            | SettingsCall::ExportPasswords(p)
            | SettingsCall::ExportBookmarks(p)
            | SettingsCall::AddExtensionFromLink(p)
            | SettingsCall::ChooseUnpackedExtension(p) => p,
            SettingsCall::RevealPassword { profile, .. }
            | SettingsCall::UpdatePassword { profile, .. }
            | SettingsCall::RemovePassword { profile, .. }
            | SettingsCall::AllowSaving { profile, .. }
            | SettingsCall::SaveAddress { profile, .. }
            | SettingsCall::SaveCard { profile, .. }
            | SettingsCall::RemoveAutofill { profile, .. }
            | SettingsCall::CardNumber { profile, .. }
            | SettingsCall::SetSiteSetting { profile, .. }
            | SettingsCall::ResetSite { profile, .. }
            | SettingsCall::ClearSiteData { profile, .. }
            | SettingsCall::SetZoom { profile, .. }
            | SettingsCall::SetExtensionEnabled { profile, .. }
            | SettingsCall::ConfigureExtension { profile, .. }
            | SettingsCall::ReloadExtension { profile, .. }
            | SettingsCall::UninstallExtension { profile, .. }
            | SettingsCall::InstallUnpackedExtension { profile, .. }
            | SettingsCall::RestoreHiddenElements { profile, .. } => profile,
            SettingsCall::ResetAnonymousId
            | SettingsCall::ViewMyData
            | SettingsCall::RevokeApproval(_) => return None,
        })
    }

    pub fn stale(&self) -> Vec<SettingsQuery> {
        let Some(p) = self.profile().cloned() else {
            return match self {
                SettingsCall::ResetAnonymousId => vec![SettingsQuery::SavedInstallId],
                SettingsCall::RevokeApproval(_) => vec![SettingsQuery::ControlApprovals],
                _ => Vec::new(),
            };
        };
        match self {
            SettingsCall::UnlockPasswords(_) => vec![
                SettingsQuery::PasswordsUnlocked(p.clone()),
                SettingsQuery::Passwords(p),
            ],
            SettingsCall::UpdatePassword { .. }
            | SettingsCall::RemovePassword { .. }
            | SettingsCall::ImportPasswords(_) => vec![SettingsQuery::Passwords(p)],
            SettingsCall::AllowSaving { .. } => vec![SettingsQuery::NeverSaved(p)],
            SettingsCall::SaveAddress { .. } | SettingsCall::SaveCard { .. } => {
                vec![SettingsQuery::Addresses(p.clone()), SettingsQuery::Cards(p)]
            }
            SettingsCall::RemoveAutofill { .. } => {
                vec![SettingsQuery::Addresses(p.clone()), SettingsQuery::Cards(p)]
            }
            SettingsCall::SetSiteSetting { origin, .. }
            | SettingsCall::ResetSite { origin, .. } => {
                vec![
                    SettingsQuery::Site(p.clone(), origin.clone()),
                    SettingsQuery::SiteOrigins(p),
                ]
            }
            SettingsCall::SetZoom { .. } => vec![SettingsQuery::Zooms(p)],
            SettingsCall::SetExtensionEnabled { .. }
            | SettingsCall::ConfigureExtension { .. }
            | SettingsCall::ReloadExtension { .. }
            | SettingsCall::UninstallExtension { .. }
            | SettingsCall::InstallUnpackedExtension { .. } => vec![SettingsQuery::Extensions(p)],
            SettingsCall::RestoreHiddenElements { .. } => vec![SettingsQuery::HiddenElements(p)],
            SettingsCall::RevealPassword { .. }
            | SettingsCall::ExportPasswords(_)
            | SettingsCall::CardNumber { .. }
            | SettingsCall::ClearSiteData { .. }
            | SettingsCall::ExportBookmarks(_)
            | SettingsCall::AddExtensionFromLink(_)
            | SettingsCall::ChooseUnpackedExtension(_)
            | SettingsCall::ResetAnonymousId
            | SettingsCall::ViewMyData
            | SettingsCall::RevokeApproval(_) => Vec::new(),
        }
    }
}

pub type CallReply = futures::channel::oneshot::Receiver<Result<Value, String>>;

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn items<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .or(Some(value))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedPassword {
    pub origin: String,
    pub username: String,
}

pub fn passwords_of(value: &Value) -> Vec<SavedPassword> {
    items(value, "passwords")
        .filter_map(|row| {
            let origin = text(row, "origin");
            (!origin.is_empty()).then(|| SavedPassword {
                origin,
                username: text(row, "username"),
            })
        })
        .collect()
}

pub fn origins_of(value: &Value, key: &str) -> Vec<String> {
    items(value, key)
        .filter_map(Value::as_str)
        .filter(|origin| !origin.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedAddress {
    pub id: String,
    pub name: String,
    pub organization: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
    pub phone: String,
    pub email: String,
}

pub const ADDRESS_FIELDS: [(&str, &str); 10] = [
    ("name", "Name"),
    ("organization", "Organization"),
    ("line1", "Street Address"),
    ("line2", "Apt, Suite, etc."),
    ("city", "City"),
    ("state", "State / Province"),
    ("postalCode", "ZIP / Postal Code"),
    ("country", "Country / Region"),
    ("phone", "Phone"),
    ("email", "Email"),
];

impl SavedAddress {
    pub fn field_values(&self) -> [String; 10] {
        let mut lines = self.street.split('\n');
        let line1 = lines.next().unwrap_or_default().to_owned();
        let line2 = lines.collect::<Vec<_>>().join(", ");
        [
            self.name.clone(),
            self.organization.clone(),
            line1,
            line2,
            self.city.clone(),
            self.state.clone(),
            self.postal_code.clone(),
            self.country.clone(),
            self.phone.clone(),
            self.email.clone(),
        ]
    }

    pub fn title(&self) -> String {
        [
            self.name.as_str(),
            first_line(&self.street),
            self.email.as_str(),
        ]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or("Address")
        .to_owned()
    }

    pub fn summary(&self) -> String {
        let place = [&self.city, &self.state, &self.postal_code]
            .into_iter()
            .filter(|part| !part.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let street = if self.name.is_empty() {
            ""
        } else {
            first_line(&self.street)
        };
        [street.to_owned(), place, self.email.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or_default()
}

pub fn address_input(id: Option<&str>, values: &[String]) -> Value {
    let get = |index: usize| values.get(index).map(|v| v.trim()).unwrap_or_default();
    let street = [get(2), get(3)]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut input = serde_json::json!({
        "name": get(0),
        "organization": get(1),
        "street": street,
        "city": get(4),
        "state": get(5),
        "postalCode": get(6),
        "country": get(7),
        "phone": get(8),
        "email": get(9),
    });
    if let Some(id) = id {
        input["id"] = Value::from(id);
    }
    input
}

pub fn addresses_of(value: &Value) -> Vec<SavedAddress> {
    items(value, "addresses")
        .filter_map(|row| {
            let id = text(row, "id");
            (!id.is_empty()).then(|| SavedAddress {
                id,
                name: text(row, "name"),
                organization: text(row, "organization"),
                street: text(row, "street"),
                city: text(row, "city"),
                state: text(row, "state"),
                postal_code: text(row, "postalCode"),
                country: text(row, "country"),
                phone: text(row, "phone"),
                email: text(row, "email"),
            })
        })
        .collect()
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SavedCard {
    pub id: String,
    pub name: String,
    pub network: String,
    pub last4: String,
    pub exp_month: Option<u32>,
    pub exp_year: Option<i32>,
}

pub fn cards_of(value: &Value) -> Vec<SavedCard> {
    items(value, "cards")
        .filter_map(|row| {
            let id = text(row, "id");
            (!id.is_empty()).then(|| SavedCard {
                id,
                name: text(row, "name"),
                network: text(row, "network"),
                last4: text(row, "last4"),
                exp_month: row
                    .get("expMonth")
                    .and_then(Value::as_u64)
                    .and_then(|m| u32::try_from(m).ok())
                    .filter(|m| (1..=12).contains(m)),
                exp_year: row
                    .get("expYear")
                    .and_then(Value::as_i64)
                    .and_then(|y| i32::try_from(y).ok())
                    .filter(|y| *y > 0),
            })
        })
        .collect()
}

pub fn card_network_name(network: &str) -> &'static str {
    match network {
        "visa" => "Visa",
        "mastercard" => "Mastercard",
        "amex" => "American Express",
        "discover" => "Discover",
        "diners" => "Diners Club",
        "jcb" => "JCB",
        "unionpay" => "UnionPay",
        _ => "Card",
    }
}

impl SavedCard {
    pub fn title(&self) -> String {
        format!("{} •••• {}", card_network_name(&self.network), self.last4)
    }

    pub fn expired(&self, now_year: i32, now_month: u32) -> bool {
        match (self.exp_month, self.exp_year) {
            (Some(month), Some(year)) => year < now_year || (year == now_year && month < now_month),
            _ => false,
        }
    }

    pub fn summary(&self, now_year: i32, now_month: u32) -> String {
        let expiry = match (self.exp_month, self.exp_year) {
            (Some(month), Some(year)) => format!(
                "{} {month:02}/{:02}",
                if self.expired(now_year, now_month) {
                    "Expired"
                } else {
                    "Expires"
                },
                year.rem_euclid(100)
            ),
            _ => String::new(),
        };
        [expiry, self.name.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

pub fn format_card_number(digits: &str) -> String {
    let digits: String = digits.chars().filter(char::is_ascii_digit).collect();
    let groups: &[usize] = if digits.starts_with("34") || digits.starts_with("37") {
        &[4, 6, 5]
    } else {
        &[4, 4, 4, 4, 3]
    };
    let mut out = Vec::new();
    let mut at = 0;
    for size in groups {
        if at >= digits.len() {
            break;
        }
        let end = (at + size).min(digits.len());
        out.push(&digits[at..end]);
        at = end;
    }
    if at < digits.len() {
        out.push(&digits[at..]);
    }
    out.join(" ")
}

pub fn card_input(id: Option<&str>, name: &str, month: Option<u32>, year: Option<i32>) -> Value {
    let mut input = serde_json::json!({ "name": name.trim() });
    if let Some(id) = id {
        input["id"] = Value::from(id);
    }
    if let Some(month) = month {
        input["expMonth"] = Value::from(month);
    }
    if let Some(year) = year {
        input["expYear"] = Value::from(year);
    }
    input
}

pub const SITE_SETTINGS: [(&str, &str); 17] = [
    ("popups", "Pop-ups and redirects"),
    ("camera", "Camera"),
    ("microphone", "Microphone"),
    ("location", "Location"),
    ("notifications", "Notifications"),
    ("sound", "Sound"),
    ("autoplay", "Autoplay"),
    ("javascript", "JavaScript"),
    ("images", "Images"),
    ("clipboard", "Clipboard"),
    ("automaticDownloads", "Automatic downloads"),
    ("cookies", "Cookies"),
    ("midi", "MIDI devices"),
    ("windowManagement", "Window management"),
    ("localFonts", "Fonts"),
    ("storageAccess", "Embedded content"),
    ("fileSystem", "File editing"),
];

pub const SITE_VALUES: [(&str, &str); 4] = [
    ("default", "Default"),
    ("allow", "Allow"),
    ("block", "Block"),
    ("ask", "Ask"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiteSetting {
    pub kind: &'static str,
    pub label: &'static str,
    pub value: String,
    pub is_default: bool,
}

pub fn site_settings_of(value: &Value) -> Vec<SiteSetting> {
    SITE_SETTINGS
        .iter()
        .filter_map(|(kind, label)| {
            let entry = value.get(*kind)?;
            let value = text(entry, "value");
            if value.is_empty() {
                return None;
            }
            Some(SiteSetting {
                kind,
                label,
                value,
                is_default: flag(entry, "isDefault"),
            })
        })
        .collect()
}

pub fn site_label(origin: &str) -> String {
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin)
        .to_owned()
}

pub fn effective_site_value(kind: &str, value: &str, block_autoplay_everywhere: bool) -> String {
    if kind == "autoplay" && block_autoplay_everywhere {
        return "block".to_owned();
    }
    value.to_owned()
}

pub fn zooms_of(value: &Value) -> Vec<(String, f64)> {
    let mut levels: Vec<(String, f64)> = value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(host, level)| Some((host.clone(), level.as_f64()?)))
        .filter(|(host, level)| !host.is_empty() && level.is_finite() && *level > 0.0)
        .collect();
    levels.sort_by(|a, b| a.0.cmp(&b.0));
    levels
}

pub fn percent(level: f64) -> String {
    format!("{}%", (level * 100.0).round() as i64)
}

pub fn cleared_status(reply: &Value) -> String {
    match reply.get("cookies").and_then(Value::as_u64) {
        Some(count) => format!(
            "Cleared {count} cookie{} and site data.",
            if count == 1 { "" } else { "s" }
        ),
        None => "Site data cleared.".to_owned(),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub icon: String,
    pub permissions: Vec<String>,
    pub site_access: Option<String>,
    pub sites: Vec<String>,
    pub options_url: Option<String>,
    pub pinned: bool,
    pub incognito: bool,
    pub user_scripts_available: bool,
    pub user_scripts: bool,
    pub may_modify: bool,
    pub errors: Vec<String>,
    pub path: Option<String>,
    pub from_web_store: bool,
    pub web_store_url: Option<String>,
}

fn optional(value: &Value, key: &str) -> Option<String> {
    Some(text(value, key)).filter(|text| !text.is_empty())
}

pub fn extensions_of(value: &Value) -> Vec<InstalledExtension> {
    items(value, "extensions")
        .filter_map(|row| {
            let id = text(row, "id");
            if id.is_empty() {
                return None;
            }
            Some(InstalledExtension {
                name: optional(row, "name").unwrap_or_else(|| id.clone()),
                id,
                version: text(row, "version"),
                description: text(row, "description"),
                enabled: flag(row, "enabled"),
                icon: text(row, "icon"),
                permissions: strings(row, "permissions"),
                site_access: optional(row, "siteAccess"),
                sites: strings(row, "sites"),
                options_url: optional(row, "optionsUrl"),
                pinned: flag(row, "pinned"),
                incognito: flag(row, "incognito"),
                user_scripts_available: flag(row, "userScriptsAvailable"),
                user_scripts: flag(row, "userScripts"),
                may_modify: flag(row, "mayModify"),
                errors: strings(row, "errors"),
                path: optional(row, "path"),
                from_web_store: flag(row, "fromWebStore"),
                web_store_url: optional(row, "webStoreUrl"),
            })
        })
        .collect()
}

pub const SITE_ACCESS: [(&str, &str); 3] = [
    ("allSites", "On all sites"),
    ("specificSites", "On specific sites"),
    ("onClick", "On click"),
];

impl InstalledExtension {
    pub fn site_access_choice(&self) -> &'static str {
        match self.site_access.as_deref() {
            Some("ON_CLICK") => "onClick",
            Some("ON_SPECIFIC_SITES") => "specificSites",
            _ => "allSites",
        }
    }

    pub fn list_subtitle(&self) -> String {
        format!(
            "  {}{}",
            self.version,
            if self.from_web_store {
                ""
            } else {
                " · Developer"
            }
        )
    }

    pub fn list_description(&self) -> String {
        if !self.enabled
            && let Some(error) = self.errors.first()
        {
            return error.clone();
        }
        self.description.clone()
    }

    pub fn version_line(&self) -> String {
        format!(
            "Version {}{}",
            self.version,
            if self.from_web_store {
                " · Chrome Web Store"
            } else {
                " · Unpacked"
            }
        )
    }
}

pub fn site_pattern_label(site: &str) -> String {
    ardia_state::extension_rules::extension_site_label(site)
}

pub fn host_label(origin: &str) -> String {
    let rest = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.strip_prefix("www.").unwrap_or(host).to_owned()
}

pub fn matches_query(query: &str, fields: &[&str]) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || fields
            .iter()
            .any(|field| field.to_lowercase().contains(&query))
}

pub fn plural(count: usize, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

pub fn import_status(reply: &Value) -> Option<String> {
    if flag(reply, "cancelled") {
        return None;
    }
    let saved = reply.get("saved").and_then(Value::as_u64).unwrap_or(0) as usize;
    let skipped = reply.get("skipped").and_then(Value::as_u64).unwrap_or(0) as usize;
    let skipped = if skipped > 0 {
        format!(" {} couldn't be saved.", plural(skipped, "login"))
    } else {
        String::new()
    };
    Some(format!("Imported {}.{skipped}", plural(saved, "password")))
}

pub fn export_status(reply: &Value) -> String {
    match text(reply, "status").as_str() {
        "succeeded" => {
            let path = text(reply, "path");
            let folder = std::path::Path::new(&path)
                .parent()
                .and_then(|p| p.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("Saved to “{folder}”. Delete the file once you're done with it.")
        }
        "writeFailed" => "Couldn't write the file. Try another folder.".to_owned(),
        "inProgress" => "An export is already running.".to_owned(),
        _ => String::new(),
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct SentGroup {
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct SentCopy {
    groups: Vec<SentGroup>,
    local: Vec<String>,
}

fn sent_copy() -> &'static SentCopy {
    static COPY: std::sync::OnceLock<SentCopy> = std::sync::OnceLock::new();
    COPY.get_or_init(|| {
        serde_json::from_str(include_str!("whats_sent.json")).unwrap_or(SentCopy {
            groups: Vec::new(),
            local: Vec::new(),
        })
    })
}

pub const SHARING_TOGGLE: &str = "Share anonymous crash reports and usage stats";
pub const KEPT_ON_THIS_MAC: &str = "Kept on this Mac";
pub const DAILY_COUNT_SHORT: &str = "Either way, Ardia sends one anonymous “opened today” count a day, with its version and macOS version and no persistent ID.";
pub const SHARING_FOOTNOTE: &str = "Sent to ardia.dev with a random ID made on this Mac, and kept on our own servers. No third parties. Turning this off stops it at once and deletes anything waiting to be sent. This setting doesn't sync.";
pub const LOCAL_SUMMARY: &str = "Ardia keeps the last 7 days of what it records here (at most 8 MB), whether sharing is on or off, so a problem report can include what led up to it.";
pub const VIEW_DATA: &str = "View My Data";
pub const VIEW_DATA_DETAIL: &str =
    "Saves the local copy to your Downloads folder and shows it in Finder.";
pub const EXPORT_FAILED: &str = "Couldn't save your data";
pub const NO_ID: &str = "No anonymous ID yet";
pub const NO_ID_DETAIL: &str = "One is made the first time you share or send a problem report.";
pub const RESET_ID: &str = "Reset My Anonymous ID";
pub const RESET_TITLE: &str = "Reset your anonymous ID?";
pub const RESET_BODY: &str = "Ardia makes a new random ID. Anything sent from now on can't be tied to what was sent before, and the copy kept on this Mac is deleted.";

pub fn appear_as(name: &str) -> String {
    format!("You appear to us as {name}")
}

pub fn id_detail(install_id: &str) -> String {
    let short: String = install_id.chars().take(8).collect();
    format!("ID {short}…, shown as a name and colours made from it. Never stored or sent.")
}

pub fn reset_done(name: &str) -> String {
    format!("You now appear to us as {name}.")
}

pub fn exported_lines(lines: u64) -> String {
    format!(
        "Saved {} {} to Downloads",
        grouped_thousands(lines),
        if lines == 1 { "line" } else { "lines" }
    )
}

fn grouped_thousands(n: u64) -> String {
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

pub fn whats_sent_intro() -> String {
    format!(
        "Only while “{SHARING_TOGGLE}” is on, except what’s under “Even with sharing off” and “{KEPT_ON_THIS_MAC}”."
    )
}

pub fn whats_sent_groups() -> Vec<(&'static str, &'static [String])> {
    let copy = sent_copy();
    let mut out: Vec<(&'static str, &'static [String])> = Vec::new();
    let Some((never, browser)) = copy.groups.split_last() else {
        return out;
    };
    out.extend(
        browser
            .iter()
            .map(|g| (g.title.as_str(), g.items.as_slice())),
    );
    out.push((KEPT_ON_THIS_MAC, copy.local.as_slice()));
    out.push((never.title.as_str(), never.items.as_slice()));
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct ControlApproval {
    pub key: String,
    pub name: String,
    pub signed_by: String,
    pub until_ms: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ControlApprovals {
    pub approvals: Vec<ControlApproval>,
    pub problem: Option<String>,
    pub doorbell: bool,
}

pub const ALLOWED_PROGRAMS_BASE: &str = "A program that isn't part of Ardia asks before it can control Ardia. The ones you allowed for 30 minutes or always are listed here.";

pub fn control_approvals_of(value: &Value) -> ControlApprovals {
    ControlApprovals {
        approvals: items(value, "approvals")
            .filter_map(|row| {
                let key = text(row, "key");
                (!key.is_empty()).then(|| ControlApproval {
                    key,
                    name: text(row, "name"),
                    signed_by: text(row, "signedBy"),
                    until_ms: row.get("until").and_then(Value::as_f64),
                })
            })
            .collect(),
        problem: Some(text(value, "problem")).filter(|p| !p.is_empty()),
        doorbell: value
            .get("doorbell")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

pub fn approval_line(approval: &ControlApproval, now_ms: f64) -> String {
    let tail = match approval.until_ms {
        Some(until) if until <= now_ms => "Expired".to_owned(),
        Some(until) => {
            let minutes = (((until - now_ms) / 60_000.0).ceil() as i64).max(1);
            if minutes == 1 {
                "Allowed for 1 more minute".to_owned()
            } else {
                format!("Allowed for {minutes} more minutes")
            }
        }
        None => "Always allowed".to_owned(),
    };
    format!("{} · {tail}", approval.signed_by)
}

pub fn allowed_programs_note(approvals: &ControlApprovals) -> Option<String> {
    if let Some(problem) = &approvals.problem {
        return Some(problem.clone());
    }
    if !approvals.doorbell {
        return Some(format!(
            "{ALLOWED_PROGRAMS_BASE} This test instance lets every program of yours in without asking."
        ));
    }
    if approvals.approvals.is_empty() {
        return Some(format!("{ALLOWED_PROGRAMS_BASE} You haven't allowed any."));
    }
    None
}

pub fn bookmarks_export_status(reply: &Value) -> Option<String> {
    let path = text(reply, "path");
    if path.is_empty() {
        return None;
    }
    let path = std::path::Path::new(&path);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Some(format!("Saved “{name}” to “{folder}”."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn passwords_and_never_saved_read_the_engine_reply() {
        let list = passwords_of(&json!({"passwords": [
            {"origin": "https://a.com", "username": "me"},
            {"origin": "", "username": "nobody"},
            "junk"
        ]}));
        assert_eq!(
            list,
            vec![SavedPassword {
                origin: "https://a.com".into(),
                username: "me".into()
            }]
        );
        assert_eq!(
            origins_of(&json!({"origins": ["https://b.com", 3, ""]}), "origins"),
            vec!["https://b.com".to_owned()]
        );
    }

    #[test]
    fn addresses_read_like_the_old_list() {
        let list = addresses_of(&json!({"addresses": [{
            "id": "1", "name": "Ada", "street": "1 Main St\nFloor 2", "city": "London",
            "postalCode": "N1", "email": "ada@x.dev"
        }]}));
        assert_eq!(list[0].title(), "Ada");
        assert_eq!(list[0].summary(), "1 Main St, London N1, ada@x.dev");
        let values = list[0].field_values();
        assert_eq!(values[2], "1 Main St");
        assert_eq!(values[3], "Floor 2");
        let input = address_input(Some("1"), &values);
        assert_eq!(input["street"], "1 Main St\nFloor 2");
        assert_eq!(input["id"], "1");
        let nameless = SavedAddress {
            street: "9 Elm".into(),
            ..Default::default()
        };
        assert_eq!(nameless.title(), "9 Elm");
        assert_eq!(SavedAddress::default().title(), "Address");
    }

    #[test]
    fn cards_format_and_summarise_like_the_old_sheet() {
        let card = cards_of(&json!({"cards": [{
            "id": "c", "network": "visa", "last4": "4242", "expMonth": 3, "expYear": 2024, "name": "Ada"
        }]}))
        .remove(0);
        assert_eq!(card.title(), "Visa •••• 4242");
        assert_eq!(card.summary(2026, 11), "Expired 03/24 · Ada");
        assert_eq!(card.summary(2024, 3), "Expires 03/24 · Ada");
        assert_eq!(
            format_card_number("4242424242424242"),
            "4242 4242 4242 4242"
        );
        assert_eq!(format_card_number("378282246310005"), "3782 822463 10005");
        assert_eq!(format_card_number("12a3"), "123");
        assert_eq!(
            card_input(Some("c"), " Ada ", Some(4), None),
            json!({"id": "c", "name": "Ada", "expMonth": 4})
        );
    }

    #[test]
    fn site_settings_keep_the_old_order_and_labels() {
        let shown = site_settings_of(&json!({
            "camera": {"value": "allow", "isDefault": false},
            "popups": {"value": "block", "isDefault": true},
            "sensors": {"value": "allow", "isDefault": true}
        }));
        assert_eq!(
            shown.iter().map(|s| s.label).collect::<Vec<_>>(),
            vec!["Pop-ups and redirects", "Camera"]
        );
        assert_eq!(site_label("https://a.com"), "a.com");
        assert_eq!(effective_site_value("autoplay", "allow", true), "block");
        assert_eq!(percent(1.25), "125%");
        assert_eq!(
            zooms_of(&json!({"b.com": 1.5, "a.com": 0.9, "": 2})),
            vec![("a.com".to_owned(), 0.9), ("b.com".to_owned(), 1.5)]
        );
        assert_eq!(
            cleared_status(&json!({"cookies": 1})),
            "Cleared 1 cookie and site data."
        );
        assert_eq!(
            cleared_status(&json!({"cookies": false})),
            "Site data cleared."
        );
    }

    #[test]
    fn extensions_read_the_engine_list() {
        let list = extensions_of(&json!({"extensions": [{
            "id": "abc", "name": "uBlock", "version": "1.2", "enabled": false,
            "errors": ["Broken manifest"], "description": "Blocks", "siteAccess": "ON_CLICK",
            "fromWebStore": false
        }, {"name": "no id"}]}));
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].list_description(), "Broken manifest");
        assert_eq!(list[0].list_subtitle(), "  1.2 · Developer");
        assert_eq!(list[0].site_access_choice(), "onClick");
        assert_eq!(list[0].version_line(), "Version 1.2 · Unpacked");
        assert_eq!(site_pattern_label("*://*.example.com/*"), "*.example.com");
        assert_eq!(
            site_pattern_label("https://a.com:8080/*"),
            "https://a.com:8080"
        );
    }

    #[test]
    fn statuses_read_like_the_old_rows() {
        assert_eq!(
            import_status(&json!({"saved": 3, "skipped": 1})).as_deref(),
            Some("Imported 3 passwords. 1 login couldn't be saved.")
        );
        assert_eq!(import_status(&json!({"cancelled": true})), None);
        assert_eq!(
            export_status(&json!({"status": "succeeded", "path": "/Users/me/Desktop/p.csv"})),
            "Saved to “Desktop”. Delete the file once you're done with it."
        );
        assert_eq!(
            bookmarks_export_status(&json!({"path": "/Users/me/Documents/Bookmarks.html"}))
                .as_deref(),
            Some("Saved “Bookmarks.html” to “Documents”.")
        );
        assert!(matches_query("gith", &["https://github.com", "me"]));
        assert_eq!(host_label("https://www.github.com/login"), "github.com");
    }

    #[test]
    fn whats_sent_keeps_the_old_group_order() {
        let groups = whats_sent_groups();
        let titles: Vec<&str> = groups.iter().map(|(title, _)| *title).collect();
        assert_eq!(titles.first(), Some(&"With everything"));
        assert_eq!(titles.last(), Some(&"Never"));
        assert_eq!(titles[titles.len() - 2], KEPT_ON_THIS_MAC);
        assert!(titles.contains(&"Even with sharing off"));
        assert!(groups.iter().all(|(_, items)| !items.is_empty()));
        assert_eq!(exported_lines(1234), "Saved 1,234 lines to Downloads");
        assert_eq!(exported_lines(1), "Saved 1 line to Downloads");
        assert!(id_detail("0123456789abcdef").starts_with("ID 01234567…,"));
    }

    #[test]
    fn approvals_read_like_the_old_rows() {
        let read = control_approvals_of(&json!({"approvals": [
            {"key": "k1", "name": "python3", "signedBy": "Not signed", "until": 1_000_000.0 + 90_000.0},
            {"key": "k2", "name": "codex", "signedBy": "OpenAI"},
            {"name": "no key"}
        ], "doorbell": true}));
        assert_eq!(read.approvals.len(), 2);
        assert_eq!(
            approval_line(&read.approvals[0], 1_000_000.0),
            "Not signed · Allowed for 2 more minutes"
        );
        assert_eq!(
            approval_line(&read.approvals[1], 0.0),
            "OpenAI · Always allowed"
        );
        assert_eq!(
            approval_line(&read.approvals[0], 2_000_000.0),
            "Not signed · Expired"
        );
        assert_eq!(allowed_programs_note(&read), None);
        let none = control_approvals_of(&json!({"approvals": []}));
        assert!(
            allowed_programs_note(&none).is_some_and(|n| n.ends_with("You haven't allowed any."))
        );
        let open = control_approvals_of(&json!({"approvals": [], "doorbell": false}));
        assert!(allowed_programs_note(&open).is_some_and(|n| n.ends_with("without asking.")));
    }

    #[test]
    fn calls_name_what_they_make_stale() {
        let p = ProfileId::from("p".to_owned());
        let call = SettingsCall::SetSiteSetting {
            profile: p.clone(),
            origin: "https://a.com".into(),
            kind: "camera".into(),
            value: "allow".into(),
        };
        assert!(
            call.stale()
                .contains(&SettingsQuery::SiteOrigins(p.clone()))
        );
        let secret = SettingsCall::UpdatePassword {
            profile: p,
            origin: "o".into(),
            username: "u".into(),
            new_username: None,
            password: Secret("hunter2".into()),
        };
        assert!(!format!("{secret:?}").contains("hunter2"));
    }
}
