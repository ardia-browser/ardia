pub const MARKER_NAME: &str = "rnw-migration.json";
pub const ATTEMPT_NAME: &str = "rnw-migration-attempt.json";
pub const LOCK_NAME: &str = "rnw-migration.lock";
pub const KEPT_FOLDER: &str = "rnw-migration-kept";
pub const CONFIG_FOLDER: &str = "config";
pub const THEMES_FOLDER: &str = "themes";
pub const SYNC_FOLDER: &str = "Sync";
pub const SECRETS_FOLDER: &str = "Secrets";
pub const PLACEMENT_NAME: &str = "window-placement.txt";
pub const CHROMIUM_USER_DATA: &str = "User Data";
pub const PARTIAL_SUFFIX: &str = ".rnw-migration.partial";

const DOCUMENT_NAME_LIMIT: usize = 200;
const ACCOUNT_LIMIT: usize = 64;
const SECRET_ACCOUNT_LIMIT: usize = 120;

const RNW_SCRATCH_FILES: [&str; 7] = [
    "dialog.json",
    "menu.json",
    "activation.log",
    "file-chooser.txt",
    "Ardia.png",
    "launch-guard.json",
    "launch-starts.txt",
];

const RNW_FOLDERS: [&str; 11] = [
    SECRETS_FOLDER,
    KEPT_FOLDER,
    CHROMIUM_USER_DATA,
    SYNC_FOLDER,
    CONFIG_FOLDER,
    "Logs",
    "Telemetry",
    "Chromium",
    "Crashpad",
    "Downloads",
    "drop-fixtures",
];

const OWN_FILES: [&str; 3] = [MARKER_NAME, ATTEMPT_NAME, LOCK_NAME];

pub const CONFIG_FILES: [&str; 2] = ["config.json", "hooks.json"];

fn reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let stem = stem.trim_end();
    matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.chars().count() == 4
            && stem
                .chars()
                .nth(3)
                .is_some_and(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³')))
}

pub fn plain_file_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > DOCUMENT_NAME_LIMIT || name == "." || name == ".." {
        return false;
    }
    if name.starts_with('.') || name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    if name
        .chars()
        .any(|c| (c as u32) < 32 || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\'))
    {
        return false;
    }
    !reserved_device_name(name)
}

pub fn document_name(name: &str) -> bool {
    plain_file_name(name)
        && !RNW_FOLDERS.iter().any(|folder| folder.eq_ignore_ascii_case(name))
        && !name.ends_with(".partial")
        && !name.ends_with(".tmp")
        && !RNW_SCRATCH_FILES
            .iter()
            .any(|scratch| scratch.eq_ignore_ascii_case(name))
        && !OWN_FILES.iter().any(|own| own.eq_ignore_ascii_case(name))
}

pub fn theme_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let lower_alnum = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    match stem.chars().next() {
        Some(first) if lower_alnum(first) => stem.chars().all(|c| lower_alnum(c) || c == '_' || c == '-'),
        _ => false,
    }
}

pub fn account_name(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= ACCOUNT_LIMIT
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn sync_key_account(file_name: &str) -> Option<&str> {
    let account = file_name.strip_prefix("sync-key-")?.strip_suffix(".dpapi")?;
    account_name(account).then_some(account)
}

pub fn sync_key_file(account: &str) -> String {
    format!("sync-key-{account}.dpapi")
}

fn lower_hex(text: &str) -> String {
    text.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn webui_sync_key_file(account: &str) -> String {
    format!("sync-key-x{}.dpapi", lower_hex(account))
}

pub fn secret_account(account: &str) -> bool {
    !account.is_empty() && account.len() <= SECRET_ACCOUNT_LIMIT && !account.chars().any(|c| (c as u32) < 32)
}

pub fn secret_file(account: &str) -> String {
    format!("account-x{}.dpapi", lower_hex(account))
}

pub fn folded(name: &str) -> String {
    name.to_lowercase()
}

pub fn sync_purpose(account: &str, test_instance: bool) -> String {
    format!(
        "ardia-sync-key/v1{}/{account}",
        if test_instance { "/test-instance" } else { "" }
    )
}

pub fn secret_purpose(account: &str, test_instance: bool) -> String {
    format!(
        "ardia-connected-account/v1{}/{account}",
        if test_instance { "/test-instance" } else { "" }
    )
}

pub const STANDARD_CREDENTIAL_SERVICE: &str = "Ardia Connected Accounts";

pub fn credential_prefix(custom_data_directory: Option<&str>) -> String {
    let Some(directory) = custom_data_directory.filter(|d| !d.is_empty()) else {
        return format!("{STANDARD_CREDENTIAL_SERVICE}/");
    };
    let mut normalized: String = directory.chars().map(|c| if c == '/' { '\\' } else { c }).collect();
    while normalized.encode_utf16().count() > 3 && normalized.ends_with('\\') {
        normalized.pop();
    }
    format!("{STANDARD_CREDENTIAL_SERVICE} [{normalized}]/")
}
