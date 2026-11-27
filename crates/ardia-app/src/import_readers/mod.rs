#[cfg(target_os = "macos")]
pub mod chromium_history;
#[cfg(target_os = "macos")]
pub mod chromium_secrets;
pub mod csv;
pub mod extensions;
pub mod plist;
#[cfg(target_os = "macos")]
pub mod safari;
#[cfg(target_os = "macos")]
pub mod safari_cookies;
#[cfg(target_os = "macos")]
pub mod sqlite;
pub mod zip;

use zeroize::Zeroizing;

#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visits: u32,
    pub last_visit_ms: f64,
}

impl HistoryEntry {
    pub fn wire(&self) -> serde_json::Value {
        serde_json::json!({ "u": self.url, "t": self.title, "n": self.visits, "l": self.last_visit_ms })
    }
}

#[derive(Clone, PartialEq)]
pub struct Credential {
    pub url: String,
    pub username: String,
    pub password: Zeroizing<String>,
    pub realm: Option<String>,
}

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credential")
            .field("url", &self.url)
            .field("username", &self.username)
            .field("realm", &self.realm)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, PartialEq)]
pub struct ImportedCard {
    pub name: Option<String>,
    pub number: Zeroizing<String>,
    pub exp_month: Option<u32>,
    pub exp_year: Option<u32>,
    pub nickname: Option<String>,
}

impl std::fmt::Debug for ImportedCard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedCard")
            .field("name", &self.name)
            .field("nickname", &self.nickname)
            .finish_non_exhaustive()
    }
}

pub fn card_digit_count(number: &str) -> Option<usize> {
    let mut digits = 0;
    for c in number.chars() {
        match c {
            '0'..='9' => digits += 1,
            ' ' | '-' => {}
            _ => return None,
        }
    }
    (12..=19).contains(&digits).then_some(digits)
}

pub fn cards_wire(cards: &[ImportedCard]) -> Zeroizing<String> {
    let list: Vec<serde_json::Value> = cards
        .iter()
        .filter(|card| card_digit_count(&card.number).is_some())
        .map(|card| {
            let digits: String = card.number.chars().filter(char::is_ascii_digit).collect();
            let mut entry = serde_json::json!({ "number": digits });
            if let Some(name) = &card.name {
                entry["name"] = serde_json::json!(name);
            }
            if let Some(month) = card.exp_month {
                entry["expMonth"] = serde_json::json!(month);
            }
            if let Some(year) = card.exp_year {
                entry["expYear"] = serde_json::json!(year);
            }
            if let Some(nickname) = &card.nickname {
                entry["nickname"] = serde_json::json!(nickname);
            }
            entry
        })
        .collect();
    Zeroizing::new(serde_json::json!({ "addresses": [], "cards": list }).to_string())
}

pub fn payment_cards(data: &[u8]) -> Result<Vec<ImportedCard>, String> {
    let top: serde_json::Value =
        serde_json::from_slice(data).map_err(|_| "PaymentCards.json is malformed".to_owned())?;
    let rows = top
        .get("payment_cards")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = |row: &serde_json::Value, key: &str| {
        row.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let int = |row: &serde_json::Value, key: &str| {
        row.get(key).and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
                .and_then(|n| u32::try_from(n).ok())
        })
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let number = Zeroizing::new(row.get("card_number")?.as_str()?.to_owned());
            card_digit_count(&number)?;
            Some(ImportedCard {
                name: text(row, "cardholder_name"),
                number,
                exp_month: int(row, "card_expiration_month").filter(|m| (1..=12).contains(m)),
                exp_year: int(row, "card_expiration_year")
                    .filter(|y| *y > 0)
                    .map(|y| if y < 100 { 2000 + y } else { y }),
                nickname: text(row, "card_name"),
            })
        })
        .collect())
}

pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

pub const WEBKIT_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;

pub fn webkit_to_unix_ms(micros: i64) -> Option<f64> {
    if micros <= 0 {
        return None;
    }
    Some((micros as f64 / 1000.0) - (WEBKIT_EPOCH_OFFSET_SECONDS as f64 * 1000.0))
}

pub const FULL_DISK_ACCESS_SETTINGS: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

pub fn safari_has_access(home: &std::path::Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        safari::has_access(home)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = home;
        false
    }
}

pub fn open_full_disk_access_settings() {
    if cfg!(target_os = "macos")
        && let Err(problem) = std::process::Command::new("/usr/bin/open")
            .arg(FULL_DISK_ACCESS_SETTINGS)
            .spawn()
    {
        log::warn!("Full Disk Access settings didn't open: {problem}");
    }
}

#[cfg(test)]
pub(crate) fn fixture(path: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/import/fixtures")
        .join(path)
}

#[cfg(test)]
mod card_tests {
    use super::*;

    #[test]
    fn export_cards_keep_valid_numbers_and_their_details() {
        let data = std::fs::read(fixture("safari/Safari Export/PaymentCards.json")).unwrap();
        let cards = payment_cards(&data).unwrap();
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].name.as_deref(), Some("Alex Example"));
        assert_eq!(cards[0].number.as_str(), "4111 1111 1111 1111");
        assert_eq!(
            (cards[0].exp_month, cards[0].exp_year),
            (Some(4), Some(2030))
        );
        assert_eq!(cards[0].nickname.as_deref(), Some("Travel"));
        assert_eq!(cards[1].nickname.as_deref(), Some("Test card"));
        assert!(cards_wire(&cards).contains("\"number\":\"4111111111111111\""));
        assert!(format!("{cards:?}").find("4111").is_none());
    }
}
