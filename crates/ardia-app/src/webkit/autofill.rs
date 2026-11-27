use std::collections::HashMap;
use std::sync::Mutex;

use ardia_engine::AutofillPrompt;
use ardia_state::TabId;
use ardia_state::actions::NewTab;
use serde_json::{Map, Value, json};
use zeroize::Zeroizing;

use super::dropdown::Row;
use super::services::{self, PageMessage, js_string};
use crate::coordinator::AppCoordinator;

pub const MAX_STRIKES: u32 = 3;
pub const MANAGE_ROW: &str = "manage";
pub const INSECURE_NOTICE: &str = "Automatic payment methods filling is disabled because this form does not use a secure connection.";
pub const MENU_DOTS: &str = "\u{202A}•\u{2060}\u{2006}\u{2060}•\u{2060}\u{2006}\u{2060}";
pub const ADDRESS_KEYS: [&str; 9] = [
    "name",
    "organization",
    "street",
    "city",
    "state",
    "postalCode",
    "country",
    "phone",
    "email",
];
pub const FIRST_PROMPT_ID: i64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Address,
    Card,
}

impl Kind {
    pub fn parse(text: &str) -> Option<Kind> {
        match text {
            "address" => Some(Kind::Address),
            "card" => Some(Kind::Card),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
struct Target {
    tab: TabId,
    frame: String,
    origin: String,
    token: String,
    kind: Kind,
    kind_type: String,
    typed: String,
    needs_number: bool,
}

#[derive(Clone, Debug)]
enum Save {
    Card {
        fields: Value,
        number: Zeroizing<String>,
    },
    Address(Value),
}

#[derive(Clone, Debug)]
struct Offer {
    id: i64,
    kind: String,
    payload: Value,
    strike_key: String,
    save: Save,
}

#[derive(Default)]
struct Offers {
    queue: Vec<Offer>,
    shown: Option<Offer>,
}

#[derive(Default)]
struct Book {
    target: Option<Target>,
    entries: Vec<Value>,
    entries_token: String,
    ticket: u64,
    offers: HashMap<TabId, Offers>,
    strikes: HashMap<String, u32>,
    last_prompt: i64,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<R>(run: impl FnOnce(&mut Book) -> R) -> R {
    let mut slot = BOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    run(slot.get_or_insert_with(|| Book {
        last_prompt: FIRST_PROMPT_ID,
        ..Book::default()
    }))
}

pub fn text(entry: &Value, key: &str) -> String {
    entry
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

pub fn street_lines(entry: &Value) -> Vec<String> {
    text(entry, "street")
        .split('\n')
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect()
}

pub fn address_value(entry: &Value, kind_type: &str, country: &dyn Fn(&str) -> String) -> String {
    let full = text(entry, "name");
    let names: Vec<&str> = full.split(' ').filter(|n| !n.is_empty()).collect();
    let lines = street_lines(entry);
    match kind_type {
        "name" => full,
        "given-name" => names.first().map(|n| (*n).to_owned()).unwrap_or_default(),
        "family-name" => {
            if names.len() > 1 {
                names.last().map(|n| (*n).to_owned()).unwrap_or_default()
            } else {
                String::new()
            }
        }
        "additional-name" => {
            if names.len() > 2 {
                names[1..names.len() - 1].join(" ")
            } else {
                String::new()
            }
        }
        "organization" => text(entry, "organization"),
        "street-address" | "address-line1" => lines.first().cloned().unwrap_or_default(),
        "address-line2" => lines.get(1).cloned().unwrap_or_default(),
        "address-line3" => {
            if lines.len() > 2 {
                lines[2..].join(", ")
            } else {
                String::new()
            }
        }
        "address-level2" => text(entry, "city"),
        "address-level1" => text(entry, "state"),
        "postal-code" => text(entry, "postalCode"),
        "country" => country(&text(entry, "country")),
        "email" => text(entry, "email"),
        other if other.starts_with("tel") => text(entry, "phone"),
        _ => String::new(),
    }
}

pub fn compact_phone(phone: &str) -> String {
    let digits: String = phone.chars().filter(char::is_ascii_digit).collect();
    if phone.trim().starts_with('+') {
        format!("+{digits}")
    } else {
        digits
    }
}

pub fn display_phone(phone: &str) -> String {
    let mut digits: String = phone.chars().filter(char::is_ascii_digit).collect();
    if digits.len() == 11 && digits.starts_with('1') {
        digits.remove(0);
    }
    if digits.len() != 10 {
        return phone.to_owned();
    }
    format!("+1 {}-{}-{}", &digits[..3], &digits[3..6], &digits[6..])
}

pub fn address_row(
    id: &str,
    entry: &Value,
    kind_type: &str,
    country: &dyn Fn(&str) -> String,
) -> Option<Row> {
    let raw = address_value(entry, kind_type, country);
    if raw.is_empty() {
        return None;
    }
    let tel = kind_type.starts_with("tel");
    let title = if tel {
        compact_phone(&raw)
    } else {
        raw.clone()
    };
    let lines = street_lines(entry);
    let first = lines.first().cloned().unwrap_or_default();
    let candidates = match kind_type {
        "email" => vec![text(entry, "phone"), text(entry, "name"), first],
        _ if tel => vec![text(entry, "email"), text(entry, "name"), first],
        "street-address" | "address-line1" => vec![
            lines.get(1).cloned().unwrap_or_default(),
            text(entry, "name"),
            text(entry, "city"),
        ],
        _ => vec![first, text(entry, "city"), text(entry, "name")],
    };
    let detail = candidates
        .into_iter()
        .find(|c| !c.is_empty() && *c != raw)
        .unwrap_or_default();
    Some(Row::new(id, &title, &detail, "mappin.and.ellipse"))
}

pub fn network_name(network: &str) -> &'static str {
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

pub fn card_label(network: &str, last4: &str) -> String {
    format!("{}  {MENU_DOTS}{last4}\u{202C}", network_name(network))
}

pub fn expiry_label(month: i64, year: i64) -> String {
    if month > 0 && year > 0 {
        format!("{:02}/{:02}", month, year % 100)
    } else {
        String::new()
    }
}

pub fn card_row(id: &str, entry: &Value, kind_type: &str) -> Option<Row> {
    let label = card_label(&text(entry, "network"), &text(entry, "last4"));
    let expiry = expiry_label(
        entry.get("expMonth").and_then(Value::as_i64).unwrap_or(0),
        entry.get("expYear").and_then(Value::as_i64).unwrap_or(0),
    );
    let card = if expiry.is_empty() {
        label
    } else {
        format!("{label} • {expiry}")
    };
    if matches!(kind_type, "cc-name" | "cc-given-name" | "cc-family-name") {
        let name = text(entry, "name");
        if name.is_empty() {
            return None;
        }
        let parts: Vec<&str> = name.split(' ').filter(|p| !p.is_empty()).collect();
        let title = match kind_type {
            "cc-given-name" => parts.first().copied().unwrap_or(&name).to_owned(),
            "cc-family-name" => parts.last().copied().unwrap_or(&name).to_owned(),
            _ => name.clone(),
        };
        return Some(Row::new(id, &title, &card, "creditcard"));
    }
    if kind_type == "cc-csc" {
        return None;
    }
    if kind_type.starts_with("cc-exp") && !expiry.is_empty() {
        return Some(Row::new(id, &expiry, &card, "creditcard"));
    }
    Some(Row::new(id, &card, "", "creditcard"))
}

pub fn matches_typed(title: &str, typed: &str) -> bool {
    if typed.is_empty() {
        return true;
    }
    let title = title.to_lowercase();
    title.starts_with(typed) || title.split([' ', ',']).any(|part| part.starts_with(typed))
}

pub fn rows_for(
    entries: &[Value],
    kind: Kind,
    kind_type: &str,
    typed: &str,
    country: &dyn Fn(&str) -> String,
) -> Vec<Row> {
    let typed = typed.to_lowercase();
    let mut seen = std::collections::HashSet::new();
    let rows: Vec<Row> = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?;
            if id == MANAGE_ROW {
                return None;
            }
            let row = match kind {
                Kind::Address => address_row(id, entry, kind_type, country),
                Kind::Card => card_row(id, entry, kind_type),
            }?;
            (matches_typed(&row.title, &typed)
                && seen.insert(format!("{}\n{}", row.title, row.detail)))
            .then_some(row)
        })
        .collect();
    if rows.is_empty() {
        return rows;
    }
    let manage = match kind {
        Kind::Address => "Manage Addresses…",
        Kind::Card => "Manage Payment Methods…",
    };
    let mut rows = rows;
    rows.push(Row::new(MANAGE_ROW, manage, "", "gearshape"));
    rows
}

pub fn network_of(number: &str) -> &'static str {
    let prefix = |n: usize| -> u32 { number.get(..n).and_then(|p| p.parse().ok()).unwrap_or(0) };
    if number.starts_with('4') {
        "visa"
    } else if (51..=55).contains(&prefix(2)) || (2221..=2720).contains(&prefix(4)) {
        "mastercard"
    } else if [34, 37].contains(&prefix(2)) {
        "amex"
    } else if prefix(4) == 6011 || prefix(2) == 65 || (644..=649).contains(&prefix(3)) {
        "discover"
    } else if (300..=305).contains(&prefix(3)) || [36, 38, 39].contains(&prefix(2)) {
        "diners"
    } else if (3528..=3589).contains(&prefix(4)) {
        "jcb"
    } else if prefix(2) == 62 {
        "unionpay"
    } else {
        "card"
    }
}

pub fn luhn(number: &str) -> bool {
    let digits: Vec<u32> = number.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() != number.chars().count() || !(12..=19).contains(&digits.len()) {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| {
            let doubled = if i % 2 == 1 { d * 2 } else { *d };
            if doubled > 9 { doubled - 9 } else { doubled }
        })
        .sum();
    sum.is_multiple_of(10)
}

pub fn importable_card(
    card: &Value,
    this_year: i64,
    this_month: i64,
) -> Option<(String, String, i64, i64)> {
    if card.get("filled").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let number = card.get("number")?.as_str()?;
    if !luhn(number) {
        return None;
    }
    let month = card.get("expMonth").and_then(Value::as_i64).unwrap_or(0);
    let year = card.get("expYear").and_then(Value::as_i64).unwrap_or(0);
    let future = year > this_year || (year == this_year && month >= this_month);
    if !(1..=12).contains(&month) || !future || year >= this_year + 25 {
        return None;
    }
    let name: String = card
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    Some((number.to_owned(), name, month, year))
}

pub fn importable_address(
    raw: &Value,
    region: &dyn Fn(&str, &str) -> Option<String>,
) -> Option<Map<String, Value>> {
    let mut address = Map::new();
    for key in ADDRESS_KEYS {
        let value = text(raw, key);
        if !value.is_empty() {
            address.insert(key.into(), Value::String(value.chars().take(300).collect()));
        }
    }
    let shown = raw
        .get("countryText")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let given = address
        .get("country")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let code = region(&given, shown).unwrap_or_else(|| "US".into());
    address.insert("country".into(), Value::String(code.clone()));
    if !address.contains_key("street") || !address.contains_key("city") {
        return None;
    }
    if code == "US" {
        let zip = address.get("postalCode").and_then(Value::as_str)?;
        let digits: Vec<char> = zip.chars().collect();
        let five = digits.len() == 5 && digits.iter().all(char::is_ascii_digit);
        let nine = (digits.len() == 9 || (digits.len() == 10 && digits[5] == '-'))
            && digits
                .iter()
                .enumerate()
                .all(|(i, c)| c.is_ascii_digit() || (i == 5 && *c == '-'));
        if !address.contains_key("state") || !(five || nine) {
            return None;
        }
    }
    if let Some(email) = address.get("email").and_then(Value::as_str) {
        let parts: Vec<&str> = email.split('@').collect();
        let ok = parts.len() == 2
            && !parts[0].is_empty()
            && !email.contains(char::is_whitespace)
            && parts[1].split('.').filter(|p| !p.is_empty()).count() >= 2
            && !parts[1].starts_with('.')
            && !parts[1].ends_with('.');
        if !ok {
            return None;
        }
    }
    if let Some(phone) = address.get("phone").and_then(Value::as_str)
        && phone.chars().filter(char::is_ascii_digit).count() < 7
    {
        return None;
    }
    Some(address)
}

pub fn folded(value: &str) -> String {
    value
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn same_value(key: &str, a: &str, b: &str) -> bool {
    let digits = |s: &str| -> String { s.chars().filter(char::is_ascii_digit).collect() };
    match key {
        "phone" => {
            let (a, b) = (digits(a), digits(b));
            let tail = |s: &str| {
                s.chars()
                    .skip(s.chars().count().saturating_sub(10))
                    .collect::<String>()
            };
            a.ends_with(&tail(&b)) || b.ends_with(&tail(&a))
        }
        "postalCode" => {
            let clean = |s: &str| -> String {
                s.chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect::<String>()
                    .to_lowercase()
                    .chars()
                    .take(5)
                    .collect()
            };
            clean(a) == clean(b)
        }
        _ => folded(a) == folded(b),
    }
}

pub fn same_street(a: &str, b: &str) -> bool {
    let left: Vec<String> = a.split('\n').map(folded).collect();
    let right: Vec<String> = b.split('\n').map(folded).collect();
    let shorter = left.len().min(right.len());
    shorter > 0 && left[..shorter] == right[..shorter]
}

pub fn same_state(a: &str, b: &str) -> bool {
    let short = [a, b].into_iter().find(|s| s.chars().count() == 2);
    let long = [a, b].into_iter().find(|s| s.chars().count() > 2);
    let (Some(short), Some(long)) = (short, long) else {
        return false;
    };
    let initials: String = long
        .to_lowercase()
        .split(' ')
        .filter_map(|w| w.chars().next())
        .collect();
    initials == short.to_lowercase() || long.to_lowercase().starts_with(&short.to_lowercase())
}

fn place_line(address: &Map<String, Value>) -> String {
    let get = |k: &str| address.get(k).and_then(Value::as_str).map(str::to_owned);
    let region = [get("state"), get("postalCode")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    [get("city"), (!region.is_empty()).then_some(region)]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn summary(address: &Map<String, Value>, country: &dyn Fn(&str) -> String) -> Vec<String> {
    let get = |k: &str| address.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut lines = Vec::new();
    lines.extend(get("name"));
    lines.extend(get("organization"));
    lines.extend(
        get("street")
            .unwrap_or_default()
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(str::to_owned),
    );
    let place = place_line(address);
    if !place.is_empty() {
        lines.push(place);
    }
    if let Some(code) = get("country") {
        lines.push(country(&code));
    }
    lines.extend(get("email"));
    if let Some(phone) = get("phone") {
        lines.push(display_phone(&phone));
    }
    lines
}

pub fn address_block(address: &Map<String, Value>, country: &dyn Fn(&str) -> String) -> String {
    let get = |k: &str| address.get(k).and_then(Value::as_str).map(str::to_owned);
    let mut lines = Vec::new();
    lines.extend(get("organization"));
    lines.extend(
        get("street")
            .unwrap_or_default()
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(str::to_owned),
    );
    let place = place_line(address);
    if !place.is_empty() {
        lines.push(place);
    }
    if let Some(code) = get("country") {
        lines.push(country(&code));
    }
    lines.join("\n")
}

#[cfg(target_os = "macos")]
mod locale {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::NSString;

    fn locale(identifier: Option<&str>) -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSLocale")?;
        unsafe {
            match identifier {
                Some(id) => msg_send![class, localeWithLocaleIdentifier: &*NSString::from_str(id)],
                None => msg_send![class, currentLocale],
            }
        }
    }

    fn name_in(locale: &AnyObject, code: &str) -> Option<String> {
        unsafe {
            let name: Option<Retained<NSString>> =
                msg_send![locale, localizedStringForCountryCode: &*NSString::from_str(code)];
            name.map(|n| n.to_string())
        }
    }

    pub fn country_name(code: &str) -> String {
        if code.is_empty() {
            return String::new();
        }
        locale(None)
            .and_then(|l| name_in(&l, code))
            .unwrap_or_else(|| code.to_owned())
    }

    pub fn current_region() -> Option<String> {
        let current = locale(None)?;
        unsafe {
            let code: Option<Retained<NSString>> = msg_send![&*current, countryCode];
            code.map(|c| c.to_string())
        }
    }

    pub fn region_code(value: &str, shown: &str) -> Option<String> {
        let candidates: Vec<String> = [value, shown]
            .iter()
            .map(|c| c.trim().to_owned())
            .filter(|c| !c.is_empty())
            .collect();
        for candidate in &candidates {
            if candidate.chars().count() == 2 && candidate.chars().all(char::is_alphabetic) {
                return Some(candidate.to_uppercase());
            }
        }
        let class = AnyClass::get(c"NSLocale")?;
        let codes: Retained<AnyObject> = unsafe { msg_send![class, ISOCountryCodes] };
        let count: usize = unsafe { msg_send![&*codes, count] };
        let locales: Vec<Retained<AnyObject>> = [locale(None), locale(Some("en_US"))]
            .into_iter()
            .flatten()
            .collect();
        for candidate in &candidates {
            let wanted = candidate.to_lowercase();
            for index in 0..count {
                let code: Retained<NSString> = unsafe { msg_send![&*codes, objectAtIndex: index] };
                let code = code.to_string();
                if code.len() != 2 {
                    continue;
                }
                if locales
                    .iter()
                    .any(|l| name_in(l, &code).is_some_and(|n| n.to_lowercase() == wanted))
                {
                    return Some(code);
                }
            }
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod locale {
    pub fn country_name(code: &str) -> String {
        code.to_owned()
    }

    pub fn current_region() -> Option<String> {
        None
    }

    pub fn region_code(value: &str, _shown: &str) -> Option<String> {
        (value.len() == 2).then(|| value.to_uppercase())
    }
}

fn country(code: &str) -> String {
    locale::country_name(code)
}

fn region(value: &str, shown: &str) -> Option<String> {
    locale::region_code(value, shown).or_else(locale::current_region)
}

fn now_year_month() -> (i64, i64) {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

impl AppCoordinator {
    fn webkit_toggles(&self, tab: &TabId) -> Option<ardia_ui::ProfileFlags> {
        let state = self.store().snapshot();
        let listed = state.tab(tab.as_str())?;
        self.engine_profile_flags(&listed.profile_id)
    }

    fn webkit_frame_secure(&self, tab: &TabId, key: &str) -> bool {
        #[cfg(target_os = "macos")]
        {
            services::frame_is_secure(tab, key)
                && services::page_url(tab).is_some_and(|u| u.starts_with("https:"))
                && services::page_secure(tab)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (tab, key);
            false
        }
    }

    pub(crate) fn webkit_autofill_message(&self, tab: &TabId, message: &PageMessage) {
        let data = &message.data;
        let Some(token) = data
            .get("token")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        else {
            return;
        };
        let page = self.webkit_page_origin(tab);
        let Some(origin) = message.origin.clone().filter(|o| Some(o) == page.as_ref()) else {
            let same = with_book(|book| book.target.as_ref().is_some_and(|t| t.token == token));
            if same {
                self.webkit_close_autofill(tab);
            }
            return;
        };
        match message.kind.as_str() {
            "field" => match data.get("event").and_then(Value::as_str).unwrap_or("show") {
                "show" | "input" => self.webkit_autofill_show(tab, token, &origin, data),
                "key" => {
                    let same =
                        with_book(|book| book.target.as_ref().is_some_and(|t| t.token == token));
                    if same {
                        self.webkit_autofill_key(
                            tab,
                            data.get("key").and_then(Value::as_str).unwrap_or_default(),
                        );
                    }
                }
                _ => {
                    let same =
                        with_book(|book| book.target.as_ref().is_some_and(|t| t.token == token));
                    if same {
                        self.webkit_close_autofill(tab);
                    }
                }
            },
            "submit" => self.webkit_autofill_submitted(tab, token, &origin, data),
            _ => {}
        }
    }

    fn webkit_autofill_show(&self, tab: &TabId, token: &str, origin: &str, data: &Value) {
        let Some(toggles) = self.webkit_toggles(tab) else {
            return self.webkit_close_autofill(tab);
        };
        let Some(kind) = data
            .get("kind")
            .and_then(Value::as_str)
            .and_then(Kind::parse)
        else {
            return self.webkit_close_autofill(tab);
        };
        let fills = match kind {
            Kind::Address => toggles.addresses_autofilled,
            Kind::Card => toggles.cards_autofilled,
        };
        let Some(kind_type) = data.get("type").and_then(Value::as_str).filter(|_| fills) else {
            return self.webkit_close_autofill(tab);
        };
        let rect = (
            data.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("y").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("width").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("height").and_then(Value::as_f64).unwrap_or(0.0),
        );
        let frame = format!("autofill:{token}");
        let target = Target {
            tab: tab.clone(),
            frame: frame.clone(),
            origin: origin.to_owned(),
            token: token.to_owned(),
            kind,
            kind_type: kind_type.to_owned(),
            typed: data
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(100)
                .collect(),
            needs_number: data.get("needsNumber").and_then(Value::as_bool) == Some(true),
        };
        let input = data.get("event").and_then(Value::as_str) == Some("input");
        let (reuse, ticket) = with_book(|book| {
            let reuse = input
                && book
                    .target
                    .as_ref()
                    .is_some_and(|t| t.token == token && t.kind == kind)
                && book.entries_token == token;
            book.target = Some(target.clone());
            book.ticket += 1;
            (reuse, book.ticket)
        });
        if kind == Kind::Card && !self.webkit_frame_secure(tab, &frame) {
            let mut notice = Row::new("", INSECURE_NOTICE, "", "lock.slash");
            notice.enabled = false;
            return self.webkit_autofill_present(tab, vec![notice], rect);
        }
        if reuse {
            let rows = with_book(|book| {
                rows_for(
                    &book.entries,
                    kind,
                    &target.kind_type,
                    &target.typed,
                    &country,
                )
            });
            return self.webkit_autofill_present(tab, rows, rect);
        }
        let service = match kind {
            Kind::Address => "ac_autofill_addresses",
            Kind::Card => "ac_autofill_cards",
        };
        let list_key = match kind {
            Kind::Address => "addresses",
            Kind::Card => "cards",
        };
        let tab = tab.clone();
        let origin = origin.to_owned();
        self.webkit_call(&tab.clone(), service, json!({}), move |c, reply| {
            let list = reply
                .get(list_key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let current = with_book(|book| {
                if book.ticket != ticket || book.target.as_ref().is_none_or(|t| t.tab != tab) {
                    return None;
                }
                book.entries = list;
                book.entries_token = target.token.clone();
                Some(rows_for(
                    &book.entries,
                    kind,
                    &target.kind_type,
                    &target.typed,
                    &country,
                ))
            });
            if c.webkit_page_origin(&tab).as_deref() != Some(origin.as_str()) {
                return;
            }
            if let Some(rows) = current {
                c.webkit_autofill_present(&tab, rows, rect);
            }
        });
    }

    fn webkit_autofill_present(&self, tab: &TabId, rows: Vec<Row>, rect: (f64, f64, f64, f64)) {
        if rows.is_empty() {
            return self.webkit_close_autofill(tab);
        }
        #[cfg(target_os = "macos")]
        {
            let Some((web, field)) = services::web_rect(tab, rect.0, rect.1, rect.2, rect.3) else {
                return self.webkit_close_autofill(tab);
            };
            let me = self.weak();
            let pick_tab = tab.clone();
            let on_pick = std::rc::Rc::new(move |row: Row| {
                if let Some(c) = me.upgrade() {
                    c.webkit_autofill_picked(&pick_tab, row);
                }
            });
            let sync_tab = tab.clone();
            let on_select = std::rc::Rc::new(move || sync_autofill_page(&sync_tab));
            let dismiss_tab = tab.clone();
            let on_dismiss = std::rc::Rc::new(move || {
                sync_autofill_page(&dismiss_tab);
                with_book(|book| book.target = None);
            });
            let shown = super::dropdown::show(
                rows,
                field,
                &web,
                super::dropdown::Handlers {
                    on_pick,
                    on_select,
                    on_dismiss,
                },
            );
            if !shown {
                return self.webkit_close_autofill(tab);
            }
            sync_autofill_page(tab);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (rows, rect);
    }

    fn webkit_autofill_key(&self, tab: &TabId, key: &str) {
        #[cfg(target_os = "macos")]
        {
            if !super::dropdown::is_shown() {
                return;
            }
            match key {
                "down" => super::dropdown::move_selection(1),
                "up" => super::dropdown::move_selection(-1),
                "enter" => match super::dropdown::selected_row() {
                    Some(row) => self.webkit_autofill_picked(tab, row),
                    None => self.webkit_close_autofill(tab),
                },
                _ => self.webkit_close_autofill(tab),
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (tab, key);
    }

    pub(crate) fn webkit_close_autofill(&self, tab: &TabId) {
        let target = with_book(|book| {
            if book.target.as_ref().is_some_and(|t| &t.tab == tab) {
                book.ticket += 1;
                book.target.take()
            } else {
                None
            }
        });
        let Some(target) = target else {
            return;
        };
        #[cfg(target_os = "macos")]
        super::dropdown::close();
        sync_target(&target, false, false);
    }

    fn webkit_autofill_picked(&self, tab: &TabId, row: Row) {
        if !row.enabled {
            return;
        }
        let Some(target) = with_book(|book| book.target.clone()).filter(|t| &t.tab == tab) else {
            return;
        };
        if row.id == MANAGE_ROW {
            self.webkit_close_autofill(tab);
            let url = match target.kind {
                Kind::Address => "ardia://settings/addresses",
                Kind::Card => "ardia://settings/payments",
            };
            let state = self.store().snapshot();
            if let Some(listed) = state.tab(tab.as_str()) {
                self.dispatch_quietly(ardia_state::Action::NewTab {
                    window: listed.window_id.clone(),
                    tab: NewTab {
                        url: Some(url.into()),
                        profile: Some(listed.profile_id.clone()),
                        opener: Some(tab.clone()),
                        background: false,
                        ..NewTab::default()
                    },
                });
            }
            return;
        }
        let Some(entry) = with_book(|book| {
            book.entries
                .iter()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(row.id.as_str()))
                .cloned()
        }) else {
            return;
        };
        self.webkit_close_autofill(tab);
        match target.kind {
            Kind::Address => {
                let mut values = Map::new();
                for key in ADDRESS_KEYS {
                    values.insert(key.into(), Value::String(text(&entry, key)));
                }
                values.insert(
                    "countryName".into(),
                    Value::String(country(&text(&entry, "country"))),
                );
                self.webkit_autofill_fill(
                    &target,
                    "address",
                    Value::Object(values),
                    "autofillAddressFill",
                );
            }
            Kind::Card => {
                let values = json!({
                    "name": text(&entry, "name"),
                    "network": text(&entry, "network"),
                    "expMonth": entry.get("expMonth").cloned().unwrap_or(Value::Null),
                    "expYear": entry.get("expYear").cloned().unwrap_or(Value::Null),
                });
                if !target.needs_number {
                    return self.webkit_autofill_fill(&target, "card", values, "autofillCardFill");
                }
                let args = Zeroizing::new(json!({ "id": row.id }).to_string());
                self.webkit_secret_call(
                    &target.tab.clone(),
                    "ac_autofill_card_number",
                    args,
                    move |c, reply| {
                        let Some(number) = reply
                            .get("number")
                            .and_then(Value::as_str)
                            .filter(|n| !n.is_empty())
                        else {
                            return c.webkit_service_count("autofillCardReauthRefused");
                        };
                        let mut values = values;
                        values["number"] = Value::String(number.to_owned());
                        c.webkit_autofill_fill(&target, "card", values, "autofillCardFill");
                    },
                );
            }
        }
    }

    fn webkit_autofill_fill(
        &self,
        target: &Target,
        kind: &str,
        values: Value,
        counted: &'static str,
    ) {
        if self.webkit_page_origin(&target.tab).as_deref() != Some(target.origin.as_str()) {
            return;
        }
        let code = Zeroizing::new(format!(
            "window.__ardiaAutofill ? window.__ardiaAutofill.fill({}, {}, {}) : 0",
            js_string(&target.token),
            js_string(kind),
            values
        ));
        let me = self.weak();
        services::run(
            &target.tab,
            Some(&target.frame),
            &code,
            Some(Box::new(move |result| {
                if result.as_ref().and_then(Value::as_f64).unwrap_or(0.0) > 0.0
                    && let Some(c) = me.upgrade()
                {
                    c.webkit_service_count(counted);
                }
            })),
        );
    }

    fn webkit_autofill_submitted(&self, tab: &TabId, token: &str, origin: &str, data: &Value) {
        let state = self.store().snapshot();
        if state.tab(tab.as_str()).is_none_or(|t| t.is_incognito()) {
            return;
        }
        let Some(toggles) = self.webkit_toggles(tab) else {
            return;
        };
        let address = toggles
            .addresses_autofilled
            .then(|| data.get("address"))
            .flatten()
            .and_then(|raw| importable_address(raw, &region));
        let secure = self.webkit_frame_secure(tab, &format!("autofill:{token}"));
        let (year, month) = now_year_month();
        let card = toggles
            .cards_autofilled
            .then_some(())
            .filter(|_| secure)
            .and_then(|_| data.get("card"))
            .and_then(|card| importable_card(card, year, month));
        match card {
            Some(card) => self.webkit_offer_card(tab, origin, card, address),
            None => {
                if let Some(address) = address {
                    self.webkit_offer_address(tab, origin, address);
                }
            }
        }
    }

    fn webkit_offer_card(
        &self,
        tab: &TabId,
        origin: &str,
        card: (String, String, i64, i64),
        address: Option<Map<String, Value>>,
    ) {
        let (number, name, month, year) = card;
        let network = network_of(&number);
        let last4: String = number
            .chars()
            .skip(number.chars().count().saturating_sub(4))
            .collect();
        let strike_key = format!("card|{network}|{last4}");
        if with_book(|book| book.strikes.get(&strike_key).copied().unwrap_or(0)) >= MAX_STRIKES {
            if let Some(address) = address {
                self.webkit_offer_address(tab, origin, address);
            }
            return;
        }
        let tab = tab.clone();
        let origin = origin.to_owned();
        let number = Zeroizing::new(number);
        self.webkit_call(
            &tab.clone(),
            "ac_autofill_cards",
            json!({}),
            move |c, reply| {
                let saved = reply
                    .get("cards")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if saved
                    .iter()
                    .any(|s| text(s, "last4") == last4 && text(s, "network") == network)
                {
                    if let Some(address) = address {
                        c.webkit_offer_address(&tab, &origin, address);
                    }
                    return;
                }
                let identifier = format!(
                    "{} • {}",
                    card_label(network, &last4),
                    expiry_label(month, year)
                );
                let payload = json!({
                    "kind": "saveCard",
                    "title": "Save card?",
                    "message": "To pay faster next time, save your card to your device",
                    "accept": "Save",
                    "decline": "No Thanks",
                    "footer": "",
                    "lines": [identifier],
                });
                let fields = json!({ "name": name, "expMonth": month, "expYear": year });
                c.webkit_enqueue_offer(
                    &tab,
                    "card",
                    payload,
                    &origin,
                    strike_key,
                    Save::Card { fields, number },
                );
            },
        );
    }

    fn webkit_offer_address(&self, tab: &TabId, origin: &str, address: Map<String, Value>) {
        let strike_key = format!("address|{origin}");
        if with_book(|book| book.strikes.get(&strike_key).copied().unwrap_or(0)) >= MAX_STRIKES {
            return;
        }
        let tab = tab.clone();
        let origin = origin.to_owned();
        self.webkit_call(
            &tab.clone(),
            "ac_autofill_addresses",
            json!({}),
            move |c, reply| {
                let saved = reply
                    .get("addresses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if let Some((kind, payload, fields)) = address_offer(&saved, &address) {
                    c.webkit_enqueue_offer(
                        &tab,
                        kind,
                        payload,
                        &origin,
                        strike_key,
                        Save::Address(fields),
                    );
                }
            },
        );
    }

    fn webkit_enqueue_offer(
        &self,
        tab: &TabId,
        kind: &str,
        payload: Value,
        origin: &str,
        strike_key: String,
        save: Save,
    ) {
        let closed = with_book(|book| {
            book.last_prompt += 1;
            let id = book.last_prompt;
            let mut full = payload;
            full["id"] = json!(id);
            full["origin"] = json!(origin);
            let offers = book.offers.entry(tab.clone()).or_default();
            offers.queue.retain(|o| o.kind != kind);
            let closed = offers
                .shown
                .take_if(|shown| shown.kind == kind)
                .map(|shown| shown.id);
            offers.queue.push(Offer {
                id,
                kind: kind.to_owned(),
                payload: full,
                strike_key,
                save,
            });
            closed
        });
        if let Some(id) = closed {
            self.webkit_close_autofill_prompt(tab, id);
        }
        self.webkit_show_next_offer(tab);
    }

    fn webkit_close_autofill_prompt(&self, tab: &TabId, id: i64) {
        if self.bridge.lock().prompts.clear_autofill(tab, Some(id)) {
            self.publish_prompts(tab);
        }
    }

    fn webkit_show_next_offer(&self, tab: &TabId) {
        let next = with_book(|book| {
            let offers = book.offers.get_mut(tab)?;
            if offers.shown.is_some() || offers.queue.is_empty() {
                return None;
            }
            let offer = offers.queue.remove(0);
            offers.shown = Some(offer.clone());
            Some(offer)
        });
        let Some(offer) = next else {
            return;
        };
        self.webkit_service_count(if offer.kind == "card" {
            "autofillCardSaveOffer"
        } else {
            "autofillAddressSaveOffer"
        });
        let Ok(prompt) = serde_json::from_value::<AutofillPrompt>(offer.payload) else {
            return;
        };
        if self.bridge.lock().prompts.autofill(tab, &prompt) {
            self.publish_prompts(tab);
        }
    }

    pub(crate) fn webkit_resolve_autofill(
        &self,
        tab: &TabId,
        prompt_id: i64,
        action: &str,
    ) -> bool {
        if !crate::webkit::page::has(tab) {
            return false;
        }
        let offer = with_book(|book| {
            let offers = book.offers.get_mut(tab)?;
            offers.shown.take_if(|shown| shown.id == prompt_id)
        });
        let Some(offer) = offer else {
            return true;
        };
        match action {
            "accept" => {
                with_book(|book| book.strikes.remove(&offer.strike_key));
                let counted = if offer.kind == "card" {
                    "autofillCardSave"
                } else {
                    "autofillAddressSave"
                };
                match offer.save {
                    Save::Card { fields, number } => {
                        let args = Zeroizing::new(
                            json!({ "card": fields, "number": number.as_str() }).to_string(),
                        );
                        self.webkit_secret_call(
                            tab,
                            "ac_autofill_save_card",
                            args,
                            move |c, reply| {
                                if reply.get("error").is_none() {
                                    c.webkit_service_count(counted);
                                }
                            },
                        );
                    }
                    Save::Address(fields) => {
                        let fields: Map<String, Value> = fields
                            .as_object()
                            .map(|o| {
                                o.iter()
                                    .filter_map(|(k, v)| match v {
                                        Value::String(s) => {
                                            Some((k.clone(), Value::String(s.clone())))
                                        }
                                        Value::Number(n) => {
                                            Some((k.clone(), Value::String(n.to_string())))
                                        }
                                        _ => None,
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        self.webkit_call(
                            tab,
                            "ac_autofill_save_address",
                            json!({ "address": fields }),
                            move |c, reply| {
                                if reply.get("error").is_none() {
                                    c.webkit_service_count(counted);
                                }
                            },
                        );
                    }
                }
            }
            "decline" => {
                with_book(|book| *book.strikes.entry(offer.strike_key.clone()).or_default() += 1)
            }
            _ => {}
        }
        self.webkit_close_autofill_prompt(tab, prompt_id);
        self.webkit_show_next_offer(tab);
        true
    }
}

fn address_offer(
    saved: &[Value],
    address: &Map<String, Value>,
) -> Option<(&'static str, Value, Value)> {
    let get = |m: &Map<String, Value>, k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
    let existing: Vec<(String, Map<String, Value>)> = saved
        .iter()
        .map(|entry| {
            let mut fields = Map::new();
            for key in ADDRESS_KEYS {
                let value = text(entry, key);
                if !value.is_empty() {
                    fields.insert(key.into(), Value::String(value));
                }
            }
            (text(entry, "id"), fields)
        })
        .collect();
    let mergeable = existing.iter().find(|(_, old)| {
        ["street", "city", "postalCode"].iter().all(|key| {
            match (get(old, key), get(address, key)) {
                (Some(a), Some(b)) => {
                    if *key == "street" {
                        same_street(&a, &b)
                    } else {
                        same_value(key, &a, &b)
                    }
                }
                (None, None) => true,
                _ => *key == "postalCode",
            }
        }) && ["name", "organization", "email", "phone", "state", "country"]
            .iter()
            .all(|key| match (get(old, key), get(address, key)) {
                (Some(a), Some(b)) => {
                    same_value(key, &a, &b) || (*key == "state" && same_state(&a, &b))
                }
                _ => true,
            })
    });
    let Some((id, old)) = mergeable else {
        let payload = json!({
            "kind": "saveAddress",
            "title": "Save address?",
            "message": "",
            "accept": "Save",
            "decline": "No thanks",
            "footer": "",
            "lines": summary(address, &country),
        });
        return Some(("address", payload, Value::Object(address.clone())));
    };
    let mut merged = old.clone();
    for key in ADDRESS_KEYS {
        let longer_street = key == "street"
            && get(address, key).map_or(0, |s| s.chars().count())
                > get(&merged, key).map_or(0, |s| s.chars().count());
        if (merged.get(key).is_none() || longer_street)
            && let Some(value) = address.get(key)
        {
            merged.insert(key.into(), value.clone());
        }
    }
    let groups: [(&str, &[&str]); 4] = [
        ("name", &["name"]),
        (
            "address",
            &[
                "organization",
                "street",
                "city",
                "state",
                "postalCode",
                "country",
            ],
        ),
        ("email", &["email"]),
        ("phone", &["phone"]),
    ];
    let changed: Vec<(&str, &[&str])> = groups
        .iter()
        .filter(|(_, keys)| keys.iter().any(|k| merged.get(*k) != old.get(*k)))
        .copied()
        .collect();
    if changed.is_empty() {
        return None;
    }
    let show = |fields: &Map<String, Value>, field: &str, keys: &[&str]| -> String {
        match field {
            "address" => address_block(fields, &country),
            "phone" => get(fields, "phone")
                .map(|p| display_phone(&p))
                .unwrap_or_default(),
            _ => get(fields, keys[0]).unwrap_or_default(),
        }
    };
    let changes: Vec<Value> = changed
        .iter()
        .map(|(field, keys)| json!({ "field": field, "to": show(&merged, field, keys), "from": show(old, field, keys) }))
        .collect();
    let adds_only = changes
        .iter()
        .all(|c| c["from"].as_str().unwrap_or_default().is_empty());
    let has_address = changed.iter().any(|(field, _)| *field == "address");
    let mut parts = Vec::new();
    parts.extend(get(old, "name"));
    if !has_address {
        parts.extend(get(old, "street").and_then(|s| s.split('\n').next().map(str::to_owned)));
    }
    let payload = json!({
        "kind": "updateAddress",
        "title": "Update address?",
        "message": parts.join(", "),
        "accept": "Update",
        "decline": "No thanks",
        "footer": "",
        "lines": [],
        "changes": changes,
        "newLabel": if adds_only { "" } else { "New" },
        "oldLabel": if adds_only { "" } else { "Old" },
    });
    let mut fields = merged;
    fields.insert("id".into(), Value::String(id.clone()));
    Some(("addressUpdate", payload, Value::Object(fields)))
}

fn sync_target(target: &Target, open: bool, picking: bool) {
    let code = format!(
        "window.__ardiaAutofill && window.__ardiaAutofill.dropdown({}, {open}, {picking})",
        js_string(&target.token)
    );
    services::run(&target.tab, Some(&target.frame), &code, None);
}

fn sync_autofill_page(tab: &TabId) {
    let Some(target) = with_book(|book| book.target.clone()).filter(|t| &t.tab == tab) else {
        return;
    };
    #[cfg(target_os = "macos")]
    let (open, picking) = (
        super::dropdown::is_shown(),
        super::dropdown::selected_row().is_some(),
    );
    #[cfg(not(target_os = "macos"))]
    let (open, picking) = (false, false);
    sync_target(&target, open, picking);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(code: &str) -> String {
        code.to_owned()
    }

    #[test]
    fn address_rows_pick_the_old_details() {
        let entry = json!({ "id": "a1", "name": "Ann Lee Smith", "street": "1 Main St\nApt 2", "city": "Oslo", "phone": "+1 (555) 123-4567", "email": "a@b.co" });
        assert_eq!(address_value(&entry, "given-name", &plain), "Ann");
        assert_eq!(address_value(&entry, "family-name", &plain), "Smith");
        assert_eq!(address_value(&entry, "additional-name", &plain), "Lee");
        assert_eq!(address_value(&entry, "address-line2", &plain), "Apt 2");
        let row = address_row("a1", &entry, "tel", &plain).unwrap();
        assert_eq!(row.title, "+15551234567");
        assert_eq!(row.detail, "a@b.co");
        let rows = rows_for(&[entry], Kind::Address, "street-address", "", &plain);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].detail, "Apt 2");
        assert_eq!(rows[1].title, "Manage Addresses…");
    }

    #[test]
    fn cards_follow_the_old_labels_and_checks() {
        let entry = json!({ "id": "c", "network": "visa", "last4": "4242", "expMonth": 3, "expYear": 2031, "name": "Ann Smith" });
        let row = card_row("c", &entry, "cc-number").unwrap();
        assert!(row.title.starts_with("Visa  "));
        assert!(row.title.contains("4242"));
        assert!(row.title.ends_with("03/31"));
        assert_eq!(card_row("c", &entry, "cc-exp").unwrap().title, "03/31");
        assert_eq!(
            card_row("c", &entry, "cc-family-name").unwrap().title,
            "Smith"
        );
        assert!(card_row("c", &entry, "cc-csc").is_none());
        assert!(luhn("4242424242424242"));
        assert!(!luhn("4242424242424241"));
        assert_eq!(network_of("5555555555554444"), "mastercard");
        assert_eq!(network_of("378282246310005"), "amex");
        let card = json!({ "number": "4242424242424242", "expMonth": 12, "expYear": 2030 });
        assert!(importable_card(&card, 2026, 11).is_some());
        assert!(
            importable_card(
                &json!({ "number": "4242424242424242", "expMonth": 1, "expYear": 2026 }),
                2026,
                11
            )
            .is_none()
        );
    }

    #[test]
    fn addresses_validate_and_merge_like_the_old_app() {
        let region =
            |v: &str, _: &str| -> Option<String> { (v.len() == 2).then(|| v.to_uppercase()) };
        let raw = json!({ "street": "1 Main St", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "us", "email": "a@b.co" });
        let address = importable_address(&raw, &region).unwrap();
        assert_eq!(address["country"], "US");
        assert!(importable_address(&json!({ "street": "1", "city": "x", "country": "US", "state": "TX", "postalCode": "1" }), &region).is_none());
        let (kind, payload, _) = address_offer(&[], &address).unwrap();
        assert_eq!(kind, "address");
        assert_eq!(payload["title"], "Save address?");
        let saved = vec![
            json!({ "id": "s1", "street": "1 Main St", "city": "Austin", "state": "TX", "postalCode": "78701", "country": "US" }),
        ];
        let (kind, payload, fields) = address_offer(&saved, &address).unwrap();
        assert_eq!(kind, "addressUpdate");
        assert_eq!(payload["changes"][0]["field"], "email");
        assert_eq!(payload["newLabel"], "");
        assert_eq!(fields["id"], "s1");
        assert!(same_state("NY", "New York"));
        assert!(same_value("phone", "+1 555 123 4567", "5551234567"));
        assert_eq!(display_phone("5551234567"), "+1 555-123-4567");
    }

    #[test]
    fn dates_are_civil() {
        let (year, month) = now_year_month();
        assert!(year >= 2024);
        assert!((1..=12).contains(&month));
    }
}
