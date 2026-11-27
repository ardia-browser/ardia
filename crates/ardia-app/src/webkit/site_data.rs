#[cfg(target_os = "macos")]
pub mod native;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_engine::{EngineTabId, Services};
use ardia_state::engines::tab_engine;
use ardia_state::model::PageEngine;
use ardia_state::{ProfileId, TabId};
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::telemetry::{self, SiteDataCarry, SiteDataSkip};
use crate::coordinator::AppCoordinator;

pub const DOC: &str = "site-data-carry.json";
pub const DOC_VERSION: u64 = 1;
pub const CARRY_DEADLINE: Duration = Duration::from_millis(1500);
pub const LOOKUP_DEADLINE: Duration = Duration::from_millis(400);
pub const SAVE_DELAY: Duration = Duration::from_secs(5);
pub const MAX_SITES: usize = 400;
pub const MAX_ORIGINS: usize = 6;
pub const MAX_HOPS: usize = 6;
pub const MAX_COOKIE_KEYS: usize = 20_000;
pub const MAX_STORAGE_ORIGINS: usize = 400;
pub const TOUCH_STEP_MS: f64 = 5_000.0;
pub const HOP_WINDOW_MS: f64 = 3.0 * 60_000.0;
pub const WEBKIT_PURGE_WINDOW_MS: f64 = 7.0 * 24.0 * 60.0 * 60_000.0;
pub const MAX_READ_DOMAINS: usize = 64;
pub const MAX_WEBKIT_COOKIES: usize = 4000;
pub const MAX_EXPORTED: usize = 500;
pub const RECENT_LIMIT: usize = 30;

pub type Base = BTreeMap<String, String>;
type DomainGroup = (Vec<String>, Vec<String>, HashSet<String>);
type ChromiumWritten = (u64, u64, u64, HashSet<String>);
pub type StorageItems = Vec<(String, String)>;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub expires: f64,
    #[serde(default)]
    pub session: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_key: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_key_opaque: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StorageChange {
    pub set: StorageItems,
    pub remove: Vec<String>,
}

pub fn fingerprint_of(text: &str) -> String {
    let mut low: u32 = 0x811c9dc5;
    let mut high: u32 = 0x050c5d1f;
    let mut length = 0u32;
    for code in text.encode_utf16() {
        let code = code as u32;
        low = (low ^ code).wrapping_mul(0x01000193);
        high = (high ^ code).wrapping_mul(0x01000193);
        high ^= low >> 15;
        length += 1;
    }
    format!("{}.{}.{}", base36(high), base36(low), base36(length))
}

fn base36(mut value: u32) -> String {
    if value == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while value > 0 {
        out.push(digits[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn cookie_key(cookie: &PageCookie) -> String {
    let path = if cookie.path.is_empty() {
        "/"
    } else {
        &cookie.path
    };
    format!(
        "{}\u{1}{}\u{1}{path}",
        cookie.name,
        cookie.domain.to_lowercase()
    )
}

pub fn domain_of_key(key: &str) -> &str {
    key.split('\u{1}').nth(1).unwrap_or("")
}

pub fn cookie_fingerprint(cookie: &PageCookie) -> String {
    let expiry = if cookie.session || cookie.expires <= 0.0 || !cookie.expires.is_finite() {
        "s".to_owned()
    } else {
        format!("{}", (cookie.expires / 60.0).floor() as i64)
    };
    format!("{}|{expiry}", fingerprint_of(&cookie.value))
}

pub fn storage_fingerprint(value: &str) -> String {
    fingerprint_of(value)
}

pub fn usable_cookie(cookie: &PageCookie, now_seconds: f64) -> bool {
    !cookie.name.is_empty()
        && !cookie.domain.is_empty()
        && cookie.partition_key.as_ref().is_none_or(Value::is_null)
        && cookie.partition_key_opaque != Some(true)
        && (cookie.session || cookie.expires <= 0.0 || cookie.expires > now_seconds)
}

pub fn cookie_map(cookies: &[PageCookie], now_seconds: f64) -> BTreeMap<String, PageCookie> {
    cookies
        .iter()
        .filter(|c| usable_cookie(c, now_seconds))
        .map(|c| (cookie_key(c), c.clone()))
        .collect()
}

pub fn storage_map(items: &StorageItems) -> BTreeMap<String, String> {
    items.iter().cloned().collect()
}

pub fn bare_domain(domain: &str) -> String {
    domain.trim_matches('.').to_lowercase()
}

pub fn covered_by(domain: &str, domains: &[String]) -> bool {
    let bare = domain.to_lowercase();
    let bare = bare.trim_start_matches('.');
    !bare.is_empty()
        && domains
            .iter()
            .any(|d| bare == d || bare.ends_with(&format!(".{d}")))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Merged<T> {
    pub put: Vec<(String, T)>,
    pub drop: Vec<(String, T)>,
    pub base: Base,
    pub conflicts: u64,
    pub held: u64,
}

pub fn merge_into<T: Clone>(
    source: &BTreeMap<String, T>,
    dest: &BTreeMap<String, T>,
    base: &Base,
    fingerprint: impl Fn(&T) -> String,
    source_wins: bool,
    source_drops_count: bool,
) -> Merged<T> {
    let mut merged = Merged {
        put: Vec::new(),
        drop: Vec::new(),
        base: base.clone(),
        conflicts: 0,
        held: 0,
    };
    let mut keys: Vec<&String> = Vec::new();
    let mut seen: HashSet<&String> = HashSet::new();
    for key in source.keys().chain(dest.keys()).chain(base.keys()) {
        if seen.insert(key) {
            keys.push(key);
        }
    }
    for key in keys {
        let s = source.get(key);
        let d = dest.get(key);
        let sf = s.map(&fingerprint);
        let df = d.map(&fingerprint);
        let bf = base.get(key).cloned();
        if sf == df {
            match sf {
                None => {
                    merged.base.remove(key);
                }
                Some(f) => {
                    merged.base.insert(key.clone(), f);
                }
            }
            continue;
        }
        if sf == bf {
            continue;
        }
        if s.is_none() && !source_drops_count {
            merged.held += 1;
            continue;
        }
        if df != bf {
            merged.conflicts += 1;
            if !source_wins {
                continue;
            }
        }
        if let Some(s) = s {
            merged.put.push((key.clone(), s.clone()));
        } else if let Some(d) = d {
            merged.drop.push((key.clone(), d.clone()));
        }
        match sf {
            None => {
                merged.base.remove(key);
            }
            Some(f) => {
                merged.base.insert(key.clone(), f);
            }
        }
    }
    merged
}

pub fn settled_base(before: &Base, merged: &Base, moved: &[String], landed: bool) -> Base {
    if landed {
        return merged.clone();
    }
    let mut next = merged.clone();
    for key in moved {
        match before.get(key) {
            None => {
                next.remove(key);
            }
            Some(value) => {
                next.insert(key.clone(), value.clone());
            }
        }
    }
    next
}

pub fn scoped_base(base: &Base, domains: &[String]) -> Base {
    base.iter()
        .filter(|(key, _)| covered_by(domain_of_key(key), domains))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

pub fn chromium_cookie(cookie: &PageCookie) -> Value {
    let path = if cookie.path.is_empty() {
        "/".to_owned()
    } else {
        cookie.path.clone()
    };
    let host_only = !cookie.domain.starts_with('.');
    let host = if cookie.domain.contains(':') && !cookie.domain.starts_with('[') {
        format!("[{}]", cookie.domain)
    } else {
        cookie.domain.clone()
    };
    let mut out = json!({
        "name": cookie.name,
        "value": cookie.value,
        "path": path,
        "secure": cookie.secure,
        "httpOnly": cookie.http_only,
    });
    if host_only {
        out["url"] = json!(format!(
            "{}://{host}{path}",
            if cookie.secure { "https" } else { "http" }
        ));
    } else {
        out["domain"] = json!(cookie.domain);
    }
    let same_site = cookie
        .same_site
        .clone()
        .filter(|s| !(s == "None" && !cookie.secure));
    if let Some(same_site) = same_site {
        out["sameSite"] = json!(same_site);
    }
    if !(cookie.session || cookie.expires <= 0.0) {
        out["expires"] = json!(cookie.expires);
    }
    out
}

pub fn removal(cookie: &PageCookie) -> Value {
    json!({
        "name": cookie.name,
        "domain": cookie.domain,
        "path": if cookie.path.is_empty() { "/" } else { &cookie.path },
    })
}

pub fn cookie_from_devtools(value: &Value) -> Option<PageCookie> {
    let name = value.get("name")?.as_str()?.to_owned();
    let expires = value.get("expires").and_then(Value::as_f64).unwrap_or(-1.0);
    let session = value
        .get("session")
        .and_then(Value::as_bool)
        .unwrap_or(expires <= 0.0);
    Some(PageCookie {
        name,
        value: value.get("value")?.as_str()?.to_owned(),
        domain: value.get("domain")?.as_str()?.to_owned(),
        path: value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .to_owned(),
        expires,
        session,
        http_only: value
            .get("httpOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        secure: value
            .get("secure")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        same_site: value
            .get("sameSite")
            .and_then(Value::as_str)
            .map(str::to_owned),
        partition_key: value.get("partitionKey").cloned().filter(|v| !v.is_null()),
        partition_key_opaque: value.get("partitionKeyOpaque").and_then(Value::as_bool),
    })
}

pub fn export_wire(cookie: &PageCookie) -> Value {
    let same_site = cookie
        .same_site
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_else(|| "unspecified".into());
    let mut entry = json!({
        "name": cookie.name,
        "value": cookie.value,
        "domain": cookie.domain,
        "path": if cookie.path.is_empty() { "/" } else { &cookie.path },
        "secure": cookie.secure,
        "httpOnly": cookie.http_only,
        "sameSite": same_site,
        "sourceScheme": if cookie.secure { "secure" } else { "nonSecure" },
    });
    if !cookie.session && cookie.expires > 0.0 {
        entry["expires"] = json!(cookie.expires * 1000.0);
    }
    entry
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EngineTimes {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chromium: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webkit: Option<f64>,
}

impl EngineTimes {
    pub fn get(&self, engine: PageEngine) -> Option<f64> {
        match engine {
            PageEngine::Chromium => self.chromium,
            PageEngine::Webkit => self.webkit,
        }
    }

    pub fn set(&mut self, engine: PageEngine, at: f64) {
        match engine {
            PageEngine::Chromium => self.chromium = Some(at),
            PageEngine::Webkit => self.webkit = Some(at),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SiteEntry {
    #[serde(default)]
    pub at: EngineTimes,
    #[serde(default)]
    pub carried: EngineTimes,
    #[serde(default)]
    pub origins: Vec<String>,
    #[serde(default)]
    pub hops: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProfileLedger {
    #[serde(default)]
    pub sites: BTreeMap<String, SiteEntry>,
    #[serde(default)]
    pub cookies: Base,
    #[serde(default)]
    pub storage: BTreeMap<String, Base>,
}

pub type Ledger = BTreeMap<String, ProfileLedger>;

fn other(engine: PageEngine) -> PageEngine {
    ardia_state::engines::other_engine(engine)
}

fn push_capped(list: &mut Vec<String>, value: &str, cap: usize) -> bool {
    if list.iter().any(|v| v == value) {
        return false;
    }
    list.push(value.to_owned());
    if list.len() > cap {
        let extra = list.len() - cap;
        list.drain(..extra);
    }
    true
}

pub fn site_entry<'a>(ledger: &'a mut Ledger, profile: &str, site: &str) -> &'a mut SiteEntry {
    ledger
        .entry(profile.to_owned())
        .or_default()
        .sites
        .entry(site.to_owned())
        .or_default()
}

fn recent(entry: &SiteEntry) -> f64 {
    [
        entry.at.chromium,
        entry.at.webkit,
        entry.carried.chromium,
        entry.carried.webkit,
    ]
    .into_iter()
    .flatten()
    .fold(0.0, f64::max)
}

pub fn trim_sites(profile: &mut ProfileLedger) {
    if profile.sites.len() <= MAX_SITES {
        return;
    }
    let mut names: Vec<(String, f64)> = profile
        .sites
        .iter()
        .map(|(name, entry)| (name.clone(), recent(entry)))
        .collect();
    names.sort_by(|a, b| a.1.total_cmp(&b.1));
    let extra = names.len() - MAX_SITES;
    for (name, _) in names.into_iter().take(extra) {
        profile.sites.remove(&name);
    }
}

pub fn touch(
    ledger: &mut Ledger,
    profile: &str,
    site: &str,
    engine: PageEngine,
    now: f64,
    origin: Option<&str>,
) -> bool {
    let entry = site_entry(ledger, profile, site);
    let mut changed = false;
    let last = entry.at.get(engine).unwrap_or(0.0);
    if now - last >= TOUCH_STEP_MS || now < last {
        entry.at.set(engine, now);
        changed = true;
    }
    if let Some(origin) = origin
        && push_capped(&mut entry.origins, origin, MAX_ORIGINS)
    {
        changed = true;
    }
    if changed && let Some(profile) = ledger.get_mut(profile) {
        trim_sites(profile);
    }
    changed
}

pub fn note_origin(ledger: &mut Ledger, profile: &str, site: &str, origin: &str) -> bool {
    push_capped(
        &mut site_entry(ledger, profile, site).origins,
        origin,
        MAX_ORIGINS,
    )
}

pub fn add_hop(ledger: &mut Ledger, profile: &str, site: &str, hop: &str) -> bool {
    site != hop && push_capped(&mut site_entry(ledger, profile, site).hops, hop, MAX_HOPS)
}

pub fn needs_carry(entry: Option<&SiteEntry>, to: PageEngine, open_in_source: bool) -> bool {
    let Some(entry) = entry else {
        return true;
    };
    let Some(carried) = entry.carried.get(to) else {
        return true;
    };
    open_in_source || entry.at.get(other(to)).unwrap_or(0.0) > carried
}

pub fn source_is_newer(
    entry: Option<&SiteEntry>,
    to: PageEngine,
    open_in_source: bool,
    open_in_dest: bool,
) -> bool {
    if open_in_source != open_in_dest {
        return open_in_source;
    }
    let source = entry.and_then(|e| e.at.get(other(to))).unwrap_or(0.0);
    let dest = entry.and_then(|e| e.at.get(to)).unwrap_or(0.0);
    source >= dest
}

pub fn trusts_drops_from(from: PageEngine, last_used: Option<f64>, now: f64) -> bool {
    from == PageEngine::Chromium || now - last_used.unwrap_or(0.0) < WEBKIT_PURGE_WINDOW_MS
}

fn reach_owners(profile: &ProfileLedger) -> HashMap<String, Vec<String>> {
    let mut owners: HashMap<String, Vec<String>> = HashMap::new();
    for (site, entry) in &profile.sites {
        let mut domains: Vec<&String> = vec![site];
        domains.extend(entry.hops.iter());
        let mut seen = HashSet::new();
        for domain in domains {
            if seen.insert(domain) {
                owners.entry(domain.clone()).or_default().push(site.clone());
            }
        }
    }
    owners
}

fn owners_of(domain: &str, owners: &HashMap<String, Vec<String>>) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = domain.to_lowercase().trim_start_matches('.').to_owned();
    while !rest.is_empty() {
        if let Some(list) = owners.get(&rest) {
            found.extend(list.iter().cloned());
        }
        rest = match rest.find('.') {
            Some(dot) => rest[dot + 1..].to_owned(),
            None => String::new(),
        };
    }
    found
}

fn over_cap(cookies: usize, origins: usize) -> bool {
    cookies > MAX_COOKIE_KEYS || origins > MAX_STORAGE_ORIGINS
}

pub fn cap_bases(profile: &mut ProfileLedger) {
    if !over_cap(profile.cookies.len(), profile.storage.len()) {
        return;
    }
    let owners = reach_owners(profile);
    let mut groups: BTreeMap<String, DomainGroup> = BTreeMap::new();
    for key in profile.cookies.keys() {
        let domain = domain_of_key(key).to_owned();
        let group = groups.entry(domain.clone()).or_insert_with(|| {
            (
                Vec::new(),
                Vec::new(),
                owners_of(&domain, &owners).into_iter().collect(),
            )
        });
        group.0.push(key.clone());
    }
    for origin in profile.storage.keys() {
        let host = url::Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        let group = groups.entry(host.clone()).or_insert_with(|| {
            (
                Vec::new(),
                Vec::new(),
                owners_of(&host, &owners).into_iter().collect(),
            )
        });
        group.1.push(origin.clone());
    }
    let mut live: HashMap<String, usize> = HashMap::new();
    let mut by_site: HashMap<String, Vec<String>> = HashMap::new();
    let mut doomed: Vec<String> = Vec::new();
    for (domain, (_, _, owners)) in &groups {
        if owners.is_empty() {
            doomed.push(domain.clone());
            continue;
        }
        live.insert(domain.clone(), owners.len());
        for site in owners {
            by_site
                .entry(site.clone())
                .or_default()
                .push(domain.clone());
        }
    }
    let drop = |profile: &mut ProfileLedger, domain: &str| {
        if let Some((cookies, origins, _)) = groups.get(domain) {
            for key in cookies {
                profile.cookies.remove(key);
            }
            for origin in origins {
                profile.storage.remove(origin);
            }
        }
    };
    for domain in &doomed {
        drop(profile, domain);
    }
    let mut names: Vec<(String, f64)> = profile
        .sites
        .iter()
        .map(|(name, entry)| (name.clone(), recent(entry)))
        .collect();
    names.sort_by(|a, b| a.1.total_cmp(&b.1));
    for (name, _) in names {
        if !over_cap(profile.cookies.len(), profile.storage.len()) {
            return;
        }
        profile.sites.remove(&name);
        for domain in by_site.get(&name).cloned().unwrap_or_default() {
            let left = live.get(&domain).copied().unwrap_or(1).saturating_sub(1);
            live.insert(domain.clone(), left);
            if left == 0 {
                drop(profile, &domain);
            }
        }
    }
}

pub fn forget_session_cookies(ledger: &mut Ledger) {
    for profile in ledger.values_mut() {
        profile
            .cookies
            .retain(|_, fingerprint| !fingerprint.ends_with("|s"));
    }
}

pub fn read_ledger(text: &str) -> Ledger {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Ledger::new();
    };
    let Some(profiles) = value.get("profiles").and_then(Value::as_object) else {
        return Ledger::new();
    };
    let mut ledger = Ledger::new();
    for (name, value) in profiles {
        let Ok(mut profile) = serde_json::from_value::<ProfileLedger>(value.clone()) else {
            continue;
        };
        for entry in profile.sites.values_mut() {
            let keep = |list: &mut Vec<String>, cap: usize| {
                if list.len() > cap {
                    let extra = list.len() - cap;
                    list.drain(..extra);
                }
            };
            keep(&mut entry.origins, MAX_ORIGINS);
            keep(&mut entry.hops, MAX_HOPS);
        }
        trim_sites(&mut profile);
        cap_bases(&mut profile);
        ledger.insert(name.clone(), profile);
    }
    forget_session_cookies(&mut ledger);
    ledger
}

pub fn ledger_json(ledger: &Ledger) -> String {
    json!({ "profiles": ledger, "version": DOC_VERSION }).to_string()
}

pub fn web_origin(url: &str) -> Option<String> {
    super::site_settings::origin_of(url)
}

pub fn host_of_origin(origin: &str) -> String {
    url::Url::parse(origin)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .unwrap_or_default()
}

pub async fn with_deadline<T: 'static>(
    work: impl Future<Output = T> + 'static,
    limit: Duration,
    fallback: T,
) -> T {
    let (done, timeout) = oneshot::channel::<()>();
    let _ = std::thread::Builder::new()
        .name("ardia-site-data-deadline".into())
        .spawn(move || {
            std::thread::sleep(limit);
            let _ = done.send(());
        });
    let work = work.fuse();
    let timeout = timeout.fuse();
    futures::pin_mut!(work, timeout);
    futures::select! {
        answer = work => answer,
        _ = timeout => fallback,
    }
}

#[derive(Default)]
struct Book {
    ledger: Option<Ledger>,
    path: Option<PathBuf>,
    domains: HashMap<String, String>,
    save_pending: bool,
    trails: HashMap<TabId, Vec<(String, f64)>>,
    under_way: HashSet<String>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<T>(run: impl FnOnce(&mut Book) -> T) -> T {
    let mut guard = BOOK.lock();
    run(guard.get_or_insert_with(Book::default))
}

pub(crate) fn carry_under_way(key: &str) -> bool {
    with_book(|book| book.under_way.contains(key))
}

pub(crate) fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub(crate) fn with_ledger<T>(data_dir: Option<&Path>, run: impl FnOnce(&mut Ledger) -> T) -> T {
    with_book(|book| {
        if book.ledger.is_none() {
            let path = data_dir.map(|dir| dir.join(DOC));
            let text = path
                .as_ref()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_default();
            book.ledger = Some(read_ledger(&text));
            book.path = path;
        }
        run(book.ledger.get_or_insert_with(Ledger::new))
    })
}

fn save_now() {
    let (path, text) = with_book(|book| {
        book.save_pending = false;
        (
            book.path.clone(),
            book.ledger.as_ref().map(ledger_json).unwrap_or_default(),
        )
    });
    let Some(path) = path else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("ardia-site-data-save".into())
        .spawn(move || {
            let staging = path.with_extension("json.tmp");
            if std::fs::write(&staging, text).is_ok() {
                let _ = std::fs::rename(&staging, &path);
            } else {
                telemetry::note_site_data_skip(SiteDataSkip::Failure);
            }
        });
}

pub(crate) fn save_soon() {
    let start = with_book(|book| !std::mem::replace(&mut book.save_pending, true));
    if start {
        let _ = std::thread::Builder::new()
            .name("ardia-site-data-save-soon".into())
            .spawn(|| {
                std::thread::sleep(SAVE_DELAY);
                save_now();
            });
    }
}

pub fn site_of_host(host: &str) -> String {
    let bare = bare_domain(host);
    with_book(|book| book.domains.get(&bare).cloned()).unwrap_or(bare)
}

pub fn knows_host(host: &str) -> bool {
    with_book(|book| book.domains.contains_key(&bare_domain(host)))
}

pub fn remember_domain(host: &str, domain: &str) {
    let bare = bare_domain(host);
    let site = bare_domain(domain);
    if bare.is_empty() || site.is_empty() || !(bare == site || bare.ends_with(&format!(".{site}")))
    {
        return;
    }
    with_book(|book| {
        if book.domains.len() >= 4000
            && let Some(first) = book.domains.keys().next().cloned()
        {
            book.domains.remove(&first);
        }
        book.domains.insert(bare, site);
    });
}

#[derive(Clone, Debug, Default)]
struct ChromiumRead {
    cookies: Vec<PageCookie>,
    storage: BTreeMap<String, Option<StorageItems>>,
    page: Option<EngineTabId>,
}

#[derive(Clone, Debug, Default)]
pub struct WebKitRead {
    pub cookies: Vec<PageCookie>,
    pub storage: BTreeMap<String, Option<StorageItems>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WebKitWritten {
    pub cookies: u64,
    pub removed: u64,
    pub storage: u64,
}

fn parse_items(value: &Value) -> Option<StorageItems> {
    let list = value
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())?;
    Some(
        list.iter()
            .filter_map(|pair| {
                let pair = pair.as_array()?;
                Some((
                    pair.first()?.as_str()?.to_owned(),
                    pair.get(1)?.as_str()?.to_owned(),
                ))
            })
            .collect(),
    )
}

impl AppCoordinator {
    pub fn carries_site_data(&self) -> bool {
        self.store()
            .snapshot()
            .settings
            .engine_switch_carries_site_data
    }

    fn engine_profile_name(&self, profile: &ProfileId) -> String {
        self.store().snapshot().engine_profile(profile)
    }

    pub(crate) fn note_site_visit(&self, tab: &TabId, engine: PageEngine, url: &str) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if listed.is_incognito() {
            return;
        }
        let Some(origin) = web_origin(url) else {
            return;
        };
        let host = host_of_origin(&origin);
        let learn = self.learn_domains(vec![host.clone()]);
        self.spawn(learn);
        let profile = state.engine_profile(&listed.profile_id);
        let site = site_of_host(&host);
        let now = now_ms();
        let data_dir = self.config().data_dir.clone();
        let mut changed = with_ledger(data_dir.as_deref(), |ledger| {
            touch(ledger, &profile, &site, engine, now, Some(&origin))
        });
        let hop = with_book(|book| {
            let trail = book.trails.entry(tab.clone()).or_default();
            if trail.last().map(|(s, _)| s.as_str()) != Some(site.as_str()) {
                trail.push((site.clone(), now));
                if trail.len() > 3 {
                    trail.remove(0);
                }
            }
            match trail.as_slice() {
                [(a, at), (b, _), (c, _)] if a == c && b != c && now - at < HOP_WINDOW_MS => {
                    Some((c.clone(), b.clone()))
                }
                _ => None,
            }
        });
        if let Some((site, hop)) = hop {
            changed |= with_ledger(data_dir.as_deref(), |ledger| {
                add_hop(ledger, &profile, &site, &hop)
            });
        }
        if changed {
            save_soon();
        }
        let gone: Vec<TabId> = with_book(|book| {
            book.trails
                .keys()
                .filter(|t| state.tab(t.as_str()).is_none())
                .cloned()
                .collect()
        });
        if !gone.is_empty() {
            with_book(|book| {
                for tab in gone {
                    book.trails.remove(&tab);
                }
            });
        }
    }

    pub(crate) fn learn_domains(&self, hosts: Vec<String>) -> LocalBoxFuture<'static, ()> {
        let wanted: Vec<String> = hosts
            .into_iter()
            .map(|h| bare_domain(&h))
            .filter(|h| !h.is_empty() && !knows_host(h))
            .take(256)
            .collect();
        let Some(engine) = self.engine().filter(|_| !wanted.is_empty()) else {
            return futures::future::ready(()).boxed_local();
        };
        let reply = Services::new(engine.as_ref(), "")
            .sites()
            .registrable_domains(&wanted);
        let work = async move {
            if let Ok(value) = reply.await
                && let Some(domains) = value.get("domains").and_then(Value::as_array)
            {
                for (host, domain) in wanted.iter().zip(domains) {
                    if let Some(domain) = domain.as_str() {
                        remember_domain(host, domain);
                    }
                }
            }
        };
        with_deadline(work, LOOKUP_DEADLINE, ()).boxed_local()
    }

    fn live_chromium_pages(&self, profile: &str) -> Vec<(EngineTabId, Option<String>)> {
        let state = self.store().snapshot();
        #[expect(
            clippy::needless_collect,
            reason = "the collect releases the bridge lock before the state lookups"
        )]
        let bound: Vec<(TabId, EngineTabId)> = self
            .bridge
            .lock()
            .tabs
            .iter()
            .map(|(tab, engine_tab)| (tab.clone(), *engine_tab))
            .collect();
        bound
            .into_iter()
            .filter_map(|(tab, engine_tab)| {
                let listed = state.tab(tab.as_str())?;
                (!listed.is_incognito()
                    && state.engine_profile(&listed.profile_id) == profile
                    && tab_engine(&state, tab.as_str()) == PageEngine::Chromium)
                    .then(|| (engine_tab, web_origin(&listed.url)))
            })
            .collect()
    }

    pub(crate) fn open_in(&self, profile: &str, site: &str, engine: PageEngine) -> bool {
        let state = self.store().snapshot();
        state.tabs.values().any(|tab| {
            !tab.is_incognito()
                && state.engine_profile(&tab.profile_id) == profile
                && web_origin(&tab.url).is_some_and(|o| site_of_host(&host_of_origin(&o)) == site)
                && tab_engine(&state, tab.id.as_str()) == engine
                && (super::page::has(&tab.id) || self.engine_tab(&tab.id).is_some())
        })
    }

    fn profile_dir_of(&self, profile: &str) -> Option<String> {
        let state = self.store().snapshot();
        let id = state
            .profiles
            .values()
            .find(|p| p.engine_profile() == profile)
            .map(|p| p.id.clone())?;
        self.service_profile_dir(&id)
    }

    fn cookies_blocked(&self, profile: &str, origin: &str) -> LocalBoxFuture<'static, bool> {
        let (Some(engine), Some(dir)) = (self.engine(), self.profile_dir_of(profile)) else {
            return futures::future::ready(false).boxed_local();
        };
        let reply = Services::new(engine.as_ref(), &dir)
            .sites()
            .settings(origin);
        async move {
            reply
                .await
                .ok()
                .and_then(|v| {
                    v.get("cookies")?
                        .get("value")?
                        .as_str()
                        .map(|s| s == "block")
                })
                .unwrap_or(false)
        }
        .boxed_local()
    }

    fn read_chromium(
        &self,
        profile: &str,
        domains: &[String],
        origins: &[String],
    ) -> LocalBoxFuture<'static, Option<ChromiumRead>> {
        let Some(engine) = self.engine() else {
            return futures::future::ready(None).boxed_local();
        };
        let pages: Vec<EngineTabId> = self
            .live_chromium_pages(profile)
            .into_iter()
            .take(3)
            .map(|(tab, _)| tab)
            .collect();
        let dir = self.profile_dir_of(profile);
        let wanted: Vec<String> = domains
            .iter()
            .map(|d| d.to_lowercase())
            .filter(|d| !d.is_empty())
            .take(MAX_READ_DOMAINS)
            .collect();
        let origins = origins.to_vec();
        async move {
            let began = Instant::now();
            let mut read: Option<(EngineTabId, Vec<PageCookie>)> = None;
            for page in &pages {
                let answer = engine
                    .devtools_call(
                        *page,
                        "Network.getAllCookies",
                        None,
                        Duration::from_millis(1000),
                    )
                    .await;
                if let Ok(answer) = answer
                    && let Some(list) = answer.get("cookies").and_then(Value::as_array)
                {
                    let cookies = list
                        .iter()
                        .filter_map(cookie_from_devtools)
                        .filter(|c| covered_by(&bare_domain(&c.domain), &wanted))
                        .collect();
                    read = Some((*page, cookies));
                    break;
                }
            }
            if !wanted.is_empty() && !pages.is_empty() {
                telemetry::note_cookie_jar_read(
                    read.is_some(),
                    began.elapsed().as_secs_f64() * 1000.0,
                );
            }
            let (page, cookies) = read?;
            let mut storage = BTreeMap::new();
            if let Some(dir) = dir {
                for origin in origins {
                    let reply = Services::new(engine.as_ref(), &dir)
                        .sites()
                        .read_storage(&origin)
                        .await;
                    storage.insert(origin, reply.ok().as_ref().and_then(parse_items));
                }
            }
            Some(ChromiumRead {
                cookies,
                storage,
                page: Some(page),
            })
        }
        .boxed_local()
    }

    fn read_webkit(
        &self,
        profile: &str,
        domains: &[String],
        origins: &[String],
    ) -> LocalBoxFuture<'static, Option<WebKitRead>> {
        #[cfg(target_os = "macos")]
        {
            native::read(profile, domains, origins)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (profile, domains, origins);
            futures::future::ready(None).boxed_local()
        }
    }

    fn write_webkit(
        &self,
        profile: &str,
        set: Vec<PageCookie>,
        remove: Vec<PageCookie>,
        storage: BTreeMap<String, StorageChange>,
    ) -> LocalBoxFuture<'static, Option<WebKitWritten>> {
        #[cfg(target_os = "macos")]
        {
            native::write(profile, set, remove, storage)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (profile, set, remove, storage);
            futures::future::ready(None).boxed_local()
        }
    }

    fn write_chromium(
        &self,
        profile: &str,
        page: Option<EngineTabId>,
        set: Vec<PageCookie>,
        remove: Vec<PageCookie>,
        storage: BTreeMap<String, StorageChange>,
    ) -> LocalBoxFuture<'static, Option<ChromiumWritten>> {
        let Some(engine) = self.engine() else {
            return futures::future::ready(None).boxed_local();
        };
        let dir = self.profile_dir_of(profile);
        async move {
            let mut cookies = 0;
            let mut removed = 0;
            if let Some(page) = page {
                if !set.is_empty() {
                    let wire: Vec<Value> = set.iter().map(chromium_cookie).collect();
                    let answer = engine
                        .devtools_call(
                            page,
                            "Network.setCookies",
                            Some(json!({ "cookies": wire })),
                            Duration::from_millis(1000),
                        )
                        .await;
                    if answer.is_err() {
                        return None;
                    }
                    cookies = set.len() as u64;
                }
                for cookie in &remove {
                    let answer = engine
                        .devtools_call(
                            page,
                            "Network.deleteCookies",
                            Some(removal(cookie)),
                            Duration::from_millis(1000),
                        )
                        .await;
                    if answer.is_ok() {
                        removed += 1;
                    }
                }
            } else if !set.is_empty() || !remove.is_empty() {
                return None;
            }
            let mut stored = 0;
            let mut landed = HashSet::new();
            if let Some(dir) = dir {
                for (origin, change) in storage {
                    let wanted = (change.set.len() + change.remove.len()) as u64;
                    let set = Value::Array(change.set.iter().map(|(k, v)| json!([k, v])).collect());
                    let reply = Services::new(engine.as_ref(), &dir)
                        .sites()
                        .write_storage(&origin, set, &change.remove)
                        .await;
                    let written = reply
                        .ok()
                        .and_then(|v| v.get("written").and_then(Value::as_u64))
                        .unwrap_or(0);
                    if written >= wanted {
                        landed.insert(origin);
                    }
                    stored += written;
                }
            }
            Some((cookies, removed, stored, landed))
        }
        .boxed_local()
    }

    fn export_webkit_cookies(
        &self,
        profile: &str,
        cookies: Vec<PageCookie>,
    ) -> LocalBoxFuture<'static, u64> {
        let (Some(engine), Some(dir)) = (self.engine(), self.profile_dir_of(profile)) else {
            return futures::future::ready(0).boxed_local();
        };
        let wire: Vec<Value> = cookies.iter().take(MAX_EXPORTED).map(export_wire).collect();
        if wire.is_empty() {
            return futures::future::ready(0).boxed_local();
        }
        let reply = Services::new(engine.as_ref(), &dir).call(
            "ac_cookies_import",
            json!({ "cookies": wire, "replaceOlder": true }),
        );
        async move {
            let Ok(value) = reply.await else {
                return 0;
            };
            let imported = value.get("imported").and_then(Value::as_u64).unwrap_or(0);
            let replaced = value.get("replaced").and_then(Value::as_u64).unwrap_or(0);
            for _ in 0..replaced.min(MAX_EXPORTED as u64) {
                telemetry::note_webkit_count("cookieReplaced");
            }
            imported + replaced
        }
        .boxed_local()
    }

    pub fn carry_site(
        self: &Arc<Self>,
        profile: String,
        site: String,
        to: PageEngine,
        origin: Option<String>,
    ) -> LocalBoxFuture<'static, SiteDataCarry> {
        if !self.carries_site_data() {
            return futures::future::ready(SiteDataCarry::default()).boxed_local();
        }
        let key = format!("{profile}|{site}|{to:?}");
        if !with_book(|book| book.under_way.insert(key.clone())) {
            return super::site_sync::until_carried(key);
        }
        let me = Arc::clone(self);
        async move {
            let carry = me.carry_now(&profile, &site, to, origin.as_deref()).await;
            with_book(|book| book.under_way.remove(&key));
            carry
        }
        .boxed_local()
    }

    async fn carry_now(
        self: &Arc<Self>,
        profile: &str,
        site: &str,
        to: PageEngine,
        origin: Option<&str>,
    ) -> SiteDataCarry {
        let data_dir = self.config().data_dir.clone();
        let entry = with_ledger(data_dir.as_deref(), |ledger| {
            if let Some(origin) = origin {
                note_origin(ledger, profile, site, origin);
            }
            site_entry(ledger, profile, site).clone()
        });
        let mut known: Vec<String> = origin.map(str::to_owned).into_iter().collect();
        for o in &entry.origins {
            if !known.contains(o) {
                known.push(o.clone());
            }
        }
        let mut candidates: Vec<String> = vec![site.to_owned()];
        for hop in &entry.hops {
            if !candidates.contains(hop) {
                candidates.push(hop.clone());
            }
        }
        let mut origins = Vec::new();
        let mut blocked_hosts = Vec::new();
        for (i, o) in known.iter().enumerate() {
            if self.cookies_blocked(profile, o).await {
                if i == 0 && origin.is_some() {
                    telemetry::note_site_data_skip(SiteDataSkip::Blocked);
                    return SiteDataCarry::default();
                }
                blocked_hosts.push(host_of_origin(o));
            } else {
                origins.push(o.clone());
            }
        }
        let mut domains = Vec::new();
        for d in &candidates {
            let blocked = self.cookies_blocked(profile, &format!("https://{d}")).await
                || self.cookies_blocked(profile, &format!("http://{d}")).await;
            if blocked {
                blocked_hosts.push(d.clone());
            } else {
                domains.push(d.clone());
            }
        }
        let chromium = self.read_chromium(profile, &domains, &origins).await;
        let webkit = self.read_webkit(profile, &domains, &origins).await;
        let Some(mut webkit) = webkit else {
            return SiteDataCarry::default();
        };
        let mut chromium = chromium;
        let reaches = |cookie: &PageCookie, host: &str| {
            let domain = bare_domain(&cookie.domain);
            domain == host
                || domain.ends_with(&format!(".{host}"))
                || (cookie.domain.starts_with('.')
                    && (host == domain || host.ends_with(&format!(".{domain}"))))
        };
        let jar_before = webkit.cookies.len() + chromium.as_ref().map_or(0, |c| c.cookies.len());
        if !blocked_hosts.is_empty() {
            webkit
                .cookies
                .retain(|c| !blocked_hosts.iter().any(|h| reaches(c, h)));
            if let Some(chromium) = &mut chromium {
                chromium
                    .cookies
                    .retain(|c| !blocked_hosts.iter().any(|h| reaches(c, h)));
            }
        }
        let jar_after = webkit.cookies.len() + chromium.as_ref().map_or(0, |c| c.cookies.len());
        telemetry::note_site_data_blocked_cookies((jar_before - jar_after) as u64);
        let from = other(to);
        let now = now_ms();
        let now_seconds = now / 1000.0;
        let cookie_base = with_ledger(data_dir.as_deref(), |ledger| {
            let p = ledger.entry(profile.to_owned()).or_default();
            let scoped = scoped_base(&p.cookies, &domains);
            scoped
                .into_iter()
                .filter(|(key, _)| {
                    !blocked_hosts
                        .iter()
                        .any(|h| covered_by(domain_of_key(key), std::slice::from_ref(h)))
                })
                .collect::<Base>()
        });
        let Some(chromium) = chromium else {
            if from == PageEngine::Chromium {
                telemetry::note_site_data_skip(SiteDataSkip::ChromiumUnreadable);
                return SiteDataCarry::default();
            }
            let changed: Vec<PageCookie> = cookie_map(&webkit.cookies, now_seconds)
                .into_iter()
                .filter(|(key, c)| cookie_base.get(key) != Some(&cookie_fingerprint(c)))
                .map(|(_, c)| c)
                .collect();
            let cookies = self.export_webkit_cookies(profile, changed).await;
            telemetry::note_site_data_skip(SiteDataSkip::CookieOnlyFallback);
            let carry = SiteDataCarry {
                cookies,
                ..SiteDataCarry::default()
            };
            telemetry::note_site_data_carry(PageEngine::Chromium, carry);
            return carry;
        };
        let open_source = self.open_in(profile, site, from);
        let open_dest = self.open_in(profile, site, to);
        let wins = source_is_newer(Some(&entry), to, open_source, open_dest);
        let drops = trusts_drops_from(from, entry.at.get(from), now);
        let (source_cookies, dest_cookies, source_storage, dest_storage) =
            if from == PageEngine::Chromium {
                (
                    &chromium.cookies,
                    &webkit.cookies,
                    &chromium.storage,
                    &webkit.storage,
                )
            } else {
                (
                    &webkit.cookies,
                    &chromium.cookies,
                    &webkit.storage,
                    &chromium.storage,
                )
            };
        let cookies = merge_into(
            &cookie_map(source_cookies, now_seconds),
            &cookie_map(dest_cookies, now_seconds),
            &cookie_base,
            cookie_fingerprint,
            wins,
            drops,
        );
        let mut conflicts = cookies.conflicts;
        let mut held = cookies.held;
        let mut storage: BTreeMap<String, StorageChange> = BTreeMap::new();
        let mut storage_merges: Vec<(String, Base, Merged<String>)> = Vec::new();
        let storage_bases = with_ledger(data_dir.as_deref(), |ledger| {
            ledger
                .entry(profile.to_owned())
                .or_default()
                .storage
                .clone()
        });
        for o in &origins {
            let (Some(Some(s)), Some(Some(d))) = (source_storage.get(o), dest_storage.get(o))
            else {
                continue;
            };
            let before = storage_bases.get(o).cloned().unwrap_or_default();
            let merged = merge_into(
                &storage_map(s),
                &storage_map(d),
                &before,
                |v: &String| storage_fingerprint(v),
                wins,
                drops,
            );
            conflicts += merged.conflicts;
            held += merged.held;
            if !merged.put.is_empty() || !merged.drop.is_empty() {
                storage.insert(
                    o.clone(),
                    StorageChange {
                        set: merged.put.clone(),
                        remove: merged.drop.iter().map(|(k, _)| k.clone()).collect(),
                    },
                );
            }
            storage_merges.push((o.clone(), before, merged));
        }
        if held > 0 {
            telemetry::note_site_data_skip(SiteDataSkip::UntrustedDrops);
        }
        let put: Vec<PageCookie> = cookies.put.iter().map(|(_, c)| c.clone()).collect();
        let drop: Vec<PageCookie> = cookies.drop.iter().map(|(_, c)| c.clone()).collect();
        let writing = !put.is_empty() || !drop.is_empty() || !storage.is_empty();
        let (written_cookies, written_removed, written_storage, landed) = if !writing {
            (0, 0, 0, HashSet::new())
        } else if to == PageEngine::Webkit {
            let wanted: u64 = storage
                .values()
                .map(|c| (c.set.len() + c.remove.len()) as u64)
                .sum();
            #[expect(
                clippy::needless_collect,
                reason = "the keys are taken before storage is handed to the WebKit write"
            )]
            let keys: Vec<String> = storage.keys().cloned().collect();
            match self
                .write_webkit(profile, put.clone(), drop.clone(), storage.clone())
                .await
            {
                Some(w) => (
                    w.cookies,
                    w.removed,
                    w.storage,
                    if w.storage >= wanted {
                        keys.into_iter().collect()
                    } else {
                        HashSet::new()
                    },
                ),
                None => {
                    telemetry::note_site_data_skip(SiteDataSkip::Failure);
                    return SiteDataCarry::default();
                }
            }
        } else {
            match self
                .write_chromium(
                    profile,
                    chromium.page,
                    put.clone(),
                    drop.clone(),
                    storage.clone(),
                )
                .await
            {
                Some(w) => w,
                None => {
                    telemetry::note_site_data_skip(SiteDataSkip::Failure);
                    return SiteDataCarry::default();
                }
            }
        };
        let cookies_landed =
            written_cookies >= put.len() as u64 && written_removed >= drop.len() as u64;
        let moved: Vec<String> = cookies
            .put
            .iter()
            .chain(cookies.drop.iter())
            .map(|(k, _)| k.clone())
            .collect();
        with_ledger(data_dir.as_deref(), |ledger| {
            let p = ledger.entry(profile.to_owned()).or_default();
            for key in cookie_base.keys() {
                p.cookies.remove(key);
            }
            p.cookies.extend(settled_base(
                &cookie_base,
                &cookies.base,
                &moved,
                cookies_landed,
            ));
            for (o, before, merged) in &storage_merges {
                let keys: Vec<String> = merged
                    .put
                    .iter()
                    .map(|(k, _)| k.clone())
                    .chain(merged.drop.iter().map(|(k, _)| k.clone()))
                    .collect();
                let landed_here = !storage.contains_key(o) || landed.contains(o);
                p.storage.insert(
                    o.clone(),
                    settled_base(before, &merged.base, &keys, landed_here),
                );
            }
            if cookies_landed && storage.keys().all(|o| landed.contains(o)) {
                site_entry(ledger, profile, site).carried.set(to, now_ms());
            }
            if let Some(p) = ledger.get_mut(profile) {
                cap_bases(p);
            }
        });
        if writing {
            save_now();
        } else {
            save_soon();
        }
        let carry = SiteDataCarry {
            cookies: written_cookies,
            removed: written_removed,
            storage: written_storage,
            conflicts,
        };
        telemetry::note_site_data_carry(to, carry);
        carry
    }

    pub fn carry_for_tab(
        self: &Arc<Self>,
        tab: &TabId,
        url: &str,
        to: PageEngine,
    ) -> LocalBoxFuture<'static, u64> {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return futures::future::ready(0).boxed_local();
        };
        let Some(origin) = web_origin(url).filter(|_| !listed.is_incognito()) else {
            return futures::future::ready(0).boxed_local();
        };
        let profile = self.engine_profile_name(&listed.profile_id);
        let host = host_of_origin(&origin);
        let learn = self.learn_domains(vec![host.clone()]);
        let me = Arc::clone(self);
        async move {
            learn.await;
            let site = site_of_host(&host);
            if site.is_empty() {
                return 0;
            }
            me.carry_site(profile, site, to, Some(origin)).await.cookies
        }
        .boxed_local()
    }

    pub fn carry_sign_in(
        self: &Arc<Self>,
        tab: &TabId,
        url: &str,
        to: PageEngine,
    ) -> LocalBoxFuture<'static, u64> {
        let work = self.carry_for_tab(tab, url, to);
        async move {
            let count = with_deadline(work, CARRY_DEADLINE, 0).await;
            telemetry::note_cookies_carried(to, count);
            count
        }
        .boxed_local()
    }

    pub fn carry_recent_sites(self: &Arc<Self>, to: PageEngine) -> LocalBoxFuture<'static, ()> {
        let from = other(to);
        let data_dir = self.config().data_dir.clone();
        let mut jobs: Vec<(String, String, f64)> = with_ledger(data_dir.as_deref(), |ledger| {
            ledger
                .iter()
                .flat_map(|(profile, p)| {
                    p.sites.iter().filter_map(move |(site, entry)| {
                        let at = entry.at.get(from).unwrap_or(0.0);
                        (needs_carry(Some(entry), to, false) && at > 0.0)
                            .then(|| (profile.clone(), site.clone(), at))
                    })
                })
                .collect()
        });
        jobs.sort_by(|a, b| b.2.total_cmp(&a.2));
        jobs.truncate(RECENT_LIMIT);
        let me = Arc::clone(self);
        let work = async move {
            for (profile, site, _) in jobs {
                me.carry_site(profile, site, to, None).await;
            }
        };
        with_deadline(work, CARRY_DEADLINE, ()).boxed_local()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(name: &str, value: &str) -> PageCookie {
        PageCookie {
            name: name.into(),
            value: value.into(),
            domain: ".a.com".into(),
            path: "/".into(),
            session: true,
            ..PageCookie::default()
        }
    }

    #[test]
    fn fingerprints_match_the_old_hash() {
        assert_eq!(fingerprint_of(""), "1efc4f.ztntfp.0");
        assert_eq!(fingerprint_of("abc"), "gr5f8k.7aigaz.3");
        assert_eq!(fingerprint_of("h\u{e9}llo\u{1f600}"), "sgty4o.1w0v1v6.7");
        assert_ne!(fingerprint_of("abc"), fingerprint_of("abd"));
        let c = cookie("sid", "1");
        assert_eq!(cookie_key(&c), "sid\u{1}.a.com\u{1}/");
        assert!(cookie_fingerprint(&c).ends_with("|s"));
    }

    #[test]
    fn three_way_merge_follows_the_old_rules() {
        let a = cookie("a", "1");
        let b = cookie("b", "2");
        let source: BTreeMap<String, PageCookie> =
            [(cookie_key(&a), a.clone()), (cookie_key(&b), b.clone())].into();
        let dest: BTreeMap<String, PageCookie> = [(cookie_key(&b), b.clone())].into();
        let merged = merge_into(&source, &dest, &Base::new(), cookie_fingerprint, true, true);
        assert_eq!(merged.put.len(), 1);
        assert_eq!(merged.put[0].1.name, "a");
        assert_eq!(merged.base.len(), 2);
        let base: Base = [(cookie_key(&a), cookie_fingerprint(&a))].into();
        let gone = merge_into(&dest, &source, &base, cookie_fingerprint, true, false);
        assert_eq!(gone.held, 1);
        assert!(gone.drop.is_empty());
        let gone = merge_into(&dest, &source, &base, cookie_fingerprint, true, true);
        assert_eq!(gone.drop.len(), 1);
        let changed = cookie("a", "9");
        let mine: BTreeMap<String, PageCookie> = [(cookie_key(&changed), changed)].into();
        let theirs: BTreeMap<String, PageCookie> = [(cookie_key(&a), cookie("a", "7"))].into();
        let conflict = merge_into(&mine, &theirs, &base, cookie_fingerprint, false, true);
        assert_eq!(conflict.conflicts, 1);
        assert!(conflict.put.is_empty());
    }

    #[test]
    fn the_ledger_tracks_sites_and_round_trips() {
        let mut ledger = Ledger::new();
        assert!(touch(
            &mut ledger,
            "",
            "a.com",
            PageEngine::Chromium,
            10_000.0,
            Some("https://a.com")
        ));
        assert!(!touch(
            &mut ledger,
            "",
            "a.com",
            PageEngine::Chromium,
            11_000.0,
            None
        ));
        assert!(add_hop(&mut ledger, "", "a.com", "login.b.com"));
        let entry = ledger[""].sites["a.com"].clone();
        assert!(needs_carry(Some(&entry), PageEngine::Webkit, false));
        site_entry(&mut ledger, "", "a.com")
            .carried
            .set(PageEngine::Webkit, 20_000.0);
        let entry = ledger[""].sites["a.com"].clone();
        assert!(!needs_carry(Some(&entry), PageEngine::Webkit, false));
        assert!(needs_carry(Some(&entry), PageEngine::Webkit, true));
        ledger
            .get_mut("")
            .unwrap()
            .cookies
            .insert("x\u{1}a.com\u{1}/".into(), "f|s".into());
        let back = read_ledger(&ledger_json(&ledger));
        assert_eq!(back[""].sites["a.com"].hops, vec!["login.b.com"]);
        assert!(back[""].cookies.is_empty());
        assert!(source_is_newer(
            Some(&entry),
            PageEngine::Webkit,
            false,
            false
        ));
        assert!(!source_is_newer(
            Some(&entry),
            PageEngine::Chromium,
            false,
            false
        ));
        assert!(trusts_drops_from(PageEngine::Chromium, None, 0.0));
        assert!(!trusts_drops_from(
            PageEngine::Webkit,
            None,
            WEBKIT_PURGE_WINDOW_MS + 1.0
        ));
    }

    #[test]
    fn cookies_convert_for_chromium() {
        let mut c = cookie("sid", "v");
        c.domain = "a.com".into();
        c.secure = true;
        c.same_site = Some("None".into());
        let wire = chromium_cookie(&c);
        assert_eq!(wire["url"], "https://a.com/");
        assert_eq!(wire["sameSite"], "None");
        c.secure = false;
        assert!(chromium_cookie(&c).get("sameSite").is_none());
        let read = cookie_from_devtools(&json!({ "name": "n", "value": "v", "domain": ".x.com", "path": "/", "expires": -1, "session": true })).unwrap();
        assert!(read.session);
        assert!(covered_by(".x.com", &["x.com".into()]));
        assert!(!covered_by("evilx.com", &["x.com".into()]));
    }
}
