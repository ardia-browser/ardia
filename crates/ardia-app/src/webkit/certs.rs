use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

pub const EXCEPTION_LIFETIME: f64 = 7.0 * 86_400.0;
pub const DYNAMIC_HOST_LIMIT: usize = 5_000;
pub const MAX_AGE_LIMIT: f64 = 365.0 * 86_400.0;
pub const FATAL_ERRORS: [&str; 2] = ["invalid", "revoked"];
pub const PRELOADED_SUFFIXES: [&str; 32] = [
    "android",
    "app",
    "bank",
    "boo",
    "channel",
    "chrome",
    "dad",
    "day",
    "dev",
    "eat",
    "esq",
    "fly",
    "foo",
    "gle",
    "gmail",
    "google",
    "hangout",
    "ing",
    "insurance",
    "meet",
    "meme",
    "mov",
    "new",
    "nexus",
    "page",
    "phd",
    "play",
    "prof",
    "rsvp",
    "search",
    "youtube",
    "zip",
];

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TransportSecurity {
    pub expires: f64,
    pub subdomains: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
struct Exception {
    errors: BTreeSet<String>,
    granted: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Policy {
    exceptions: HashMap<String, HashMap<String, Exception>>,
    bypassed: HashMap<String, HashMap<String, BTreeMap<u64, BTreeSet<String>>>>,
    transport: HashMap<String, TransportSecurity>,
}

pub fn normalized_host(host: &str) -> String {
    host.to_lowercase().trim_matches('.').to_owned()
}

pub fn overridable(errors: &[String]) -> bool {
    !errors.is_empty() && !errors.iter().any(|e| FATAL_ERRORS.contains(&e.as_str()))
}

pub fn parse_header(header: &str) -> Option<(f64, bool)> {
    let mut max_age = None;
    let mut subdomains = false;
    let mut seen = BTreeSet::new();
    for directive in header.split(';') {
        let mut parts = directive.splitn(2, '=').map(str::trim);
        let name = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.next();
        if name.is_empty() {
            continue;
        }
        if !seen.insert(name.clone()) {
            return None;
        }
        match name.as_str() {
            "max-age" => {
                let raw = value?;
                let raw = if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
                    &raw[1..raw.len() - 1]
                } else {
                    raw
                };
                if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                max_age = Some(raw.parse::<f64>().ok()?.min(MAX_AGE_LIMIT));
            }
            "includesubdomains" => {
                if value.is_some() {
                    return None;
                }
                subdomains = true;
            }
            _ => {}
        }
    }
    max_age.map(|age| (age, subdomains))
}

impl Policy {
    pub fn with_transport(transport: HashMap<String, TransportSecurity>) -> Self {
        Self {
            transport,
            ..Self::default()
        }
    }

    pub fn allow(&mut self, host: &str, fingerprint: &str, errors: &[String], now: f64) {
        if !overridable(errors) {
            return;
        }
        self.exceptions
            .entry(normalized_host(host))
            .or_default()
            .insert(
                fingerprint.to_owned(),
                Exception {
                    errors: errors.iter().cloned().collect(),
                    granted: now,
                },
            );
    }

    pub fn has_exception(&self, host: &str, now: f64) -> bool {
        let name = normalized_host(host);
        self.bypassed.contains_key(&name)
            || self
                .exceptions
                .get(&name)
                .is_some_and(|by| by.values().any(|e| e.granted + EXCEPTION_LIFETIME > now))
    }

    pub fn admits(&mut self, host: &str, fingerprint: &str, errors: &[String], now: f64) -> bool {
        let name = normalized_host(host);
        let Some(exception) = self
            .exceptions
            .get(&name)
            .and_then(|by| by.get(fingerprint))
            .cloned()
        else {
            return false;
        };
        if exception.granted + EXCEPTION_LIFETIME <= now {
            if let Some(by) = self.exceptions.get_mut(&name) {
                by.remove(fingerprint);
                if by.is_empty() {
                    self.exceptions.remove(&name);
                }
            }
            return false;
        }
        if !overridable(errors) || !errors.iter().all(|e| exception.errors.contains(e)) {
            return false;
        }
        self.bypassed
            .entry(name)
            .or_default()
            .entry(fingerprint.to_owned())
            .or_default()
            .entry(exception.granted.to_bits())
            .or_default()
            .extend(errors.iter().cloned());
        true
    }

    pub fn bypassed_errors(&self, host: &str, fingerprint: Option<&str>) -> Option<Vec<String>> {
        let by_print = self.bypassed.get(&normalized_host(host))?;
        let collect = |admissions: &BTreeMap<u64, BTreeSet<String>>| {
            admissions
                .values()
                .flatten()
                .cloned()
                .collect::<BTreeSet<_>>()
        };
        match fingerprint {
            None => Some(
                by_print
                    .values()
                    .flat_map(collect)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            ),
            Some(print) => by_print
                .get(print)
                .map(|a| collect(a).into_iter().collect()),
        }
    }

    pub fn note_header(
        &mut self,
        header: &str,
        host: &str,
        fingerprint: Option<&str>,
        now: f64,
    ) -> bool {
        let name = normalized_host(host);
        let trusted_through_bypass = fingerprint.is_some_and(|print| {
            self.bypassed
                .get(&name)
                .is_some_and(|by| by.contains_key(print))
        });
        if trusted_through_bypass || name.is_empty() {
            return false;
        }
        let Some((max_age, subdomains)) = parse_header(header) else {
            return false;
        };
        if max_age <= 0.0 {
            return self.transport.remove(&name).is_some();
        }
        let entry = TransportSecurity {
            expires: now + max_age,
            subdomains,
            observed: Some(now),
        };
        if self.transport.get(&name) == Some(&entry) {
            return false;
        }
        self.transport.insert(name, entry);
        self.trim(now);
        true
    }

    pub fn requires_https(&self, host: &str, now: f64) -> bool {
        let name = normalized_host(host);
        let labels: Vec<&str> = name.split('.').collect();
        (0..labels.len()).any(|index| {
            let candidate = labels[index..].join(".");
            self.transport
                .get(&candidate)
                .is_some_and(|entry| entry.expires > now && (index == 0 || entry.subdomains))
        })
    }

    pub fn saved(&self, now: f64) -> HashMap<String, TransportSecurity> {
        self.transport
            .iter()
            .filter(|(_, e)| e.expires > now)
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    fn trim(&mut self, now: f64) {
        self.transport.retain(|_, e| e.expires > now);
        if self.transport.len() <= DYNAMIC_HOST_LIMIT {
            return;
        }
        let mut by_expiry: Vec<(String, f64)> = self
            .transport
            .iter()
            .map(|(k, v)| (k.clone(), v.expires))
            .collect();
        by_expiry.sort_by(|a, b| a.1.total_cmp(&b.1));
        let excess = self.transport.len() - DYNAMIC_HOST_LIMIT;
        for (host, _) in by_expiry.into_iter().take(excess) {
            self.transport.remove(&host);
        }
    }
}

pub struct HostList {
    bytes: Vec<u8>,
    starts: Vec<usize>,
}

impl HostList {
    pub fn new(bytes: Vec<u8>) -> Self {
        let mut starts = if bytes.is_empty() {
            Vec::new()
        } else {
            vec![0]
        };
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'\n' {
                starts.push(index + 1);
            }
        }
        Self { bytes, starts }
    }

    fn entry(&self, index: usize) -> &[u8] {
        let start = self.starts[index];
        let end = self.bytes[start..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(self.bytes.len(), |p| start + p);
        &self.bytes[start..end]
    }

    pub fn contains(&self, host: &str) -> bool {
        let (mut low, mut high) = (0, self.starts.len());
        while low < high {
            let mid = (low + high) / 2;
            match self.entry(mid).cmp(host.as_bytes()) {
                std::cmp::Ordering::Equal => return true,
                std::cmp::Ordering::Less => low = mid + 1,
                std::cmp::Ordering::Greater => high = mid,
            }
        }
        false
    }
}

pub struct Preloaded {
    subdomains: HostList,
    exact: HostList,
}

impl Preloaded {
    pub fn load(directory: &Path) -> Option<Self> {
        let read = |name: &str| -> Option<HostList> {
            let data = std::fs::read(directory.join(name)).ok()?;
            let mut raw = Vec::new();
            flate2::read::ZlibDecoder::new(&data[..])
                .read_to_end(&mut raw)
                .ok()?;
            Some(HostList::new(raw))
        };
        Some(Self {
            subdomains: read("subdomains.hosts")?,
            exact: read("exact.hosts")?,
        })
    }

    pub fn requires_https(&self, host: &str) -> bool {
        let name = host.to_lowercase().trim_matches('.').to_owned();
        if name.is_empty() || super::page_text::is_ip_address(&name) {
            return false;
        }
        if self.exact.contains(&name) {
            return true;
        }
        let mut rest = name.as_str();
        loop {
            if self.subdomains.contains(rest) {
                return true;
            }
            match rest.find('.') {
                Some(dot) => rest = &rest[dot + 1..],
                None => return false,
            }
        }
    }
}

struct Book {
    chromium_dir: Option<PathBuf>,
    resources: Option<PathBuf>,
    policies: HashMap<String, Policy>,
    preloaded: Option<Option<Preloaded>>,
}

fn book() -> &'static Mutex<Book> {
    static BOOK: OnceLock<Mutex<Book>> = OnceLock::new();
    BOOK.get_or_init(|| {
        Mutex::new(Book {
            chromium_dir: None,
            resources: None,
            policies: HashMap::new(),
            preloaded: None,
        })
    })
}

pub fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn configure(chromium_dir: Option<PathBuf>, resources: Option<PathBuf>) {
    if let Ok(mut book) = book().lock() {
        book.chromium_dir = chromium_dir;
        book.resources = resources;
    }
}

pub fn chromium_dir() -> Option<PathBuf> {
    book().lock().ok().and_then(|b| b.chromium_dir.clone())
}

pub fn transport_file(chromium_dir: &Path, store: &str) -> PathBuf {
    chromium_dir
        .join("WebKit Transport Security")
        .join(format!("p{}.json", super::page_text::hex_upper(store)))
}

fn read_saved(file: &Path) -> HashMap<String, TransportSecurity> {
    std::fs::read(file)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default()
}

fn with_policy<R>(store: &str, private: bool, run: impl FnOnce(&mut Policy) -> R) -> Option<R> {
    let mut book = book().lock().ok()?;
    if !book.policies.contains_key(store) {
        let saved = match (&book.chromium_dir, private) {
            (Some(dir), false) => read_saved(&transport_file(dir, store)),
            _ => HashMap::new(),
        };
        book.policies
            .insert(store.to_owned(), Policy::with_transport(saved));
    }
    book.policies.get_mut(store).map(run)
}

fn preloaded_requires(host: &str) -> bool {
    let Ok(mut book) = book().lock() else {
        return false;
    };
    if book.preloaded.is_none() {
        let loaded = book
            .resources
            .as_ref()
            .and_then(|r| Preloaded::load(&r.join("HSTS")));
        if loaded.is_none() {
            log::info!(
                "[webkit] the HSTS preload list isn't in the app bundle, so only hosts seen this session require HTTPS"
            );
        }
        book.preloaded = Some(loaded);
    }
    book.preloaded
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|lists| lists.requires_https(host))
}

pub fn requires_secure_transport(host: &str, store: &str, private: bool) -> bool {
    let name = normalized_host(host);
    if name
        .rsplit('.')
        .next()
        .is_some_and(|last| PRELOADED_SUFFIXES.contains(&last))
    {
        return true;
    }
    if preloaded_requires(&name) {
        return true;
    }
    with_policy(store, private, |p| p.requires_https(&name, now_seconds())).unwrap_or(false)
}

pub fn has_exception(store: &str, private: bool, host: &str) -> bool {
    with_policy(store, private, |p| p.has_exception(host, now_seconds())).unwrap_or(false)
}

pub fn allows(
    store: &str,
    private: bool,
    host: &str,
    fingerprint: &str,
    errors: &[String],
) -> bool {
    if requires_secure_transport(host, store, private) {
        return false;
    }
    with_policy(store, private, |p| {
        p.admits(host, fingerprint, errors, now_seconds())
    })
    .unwrap_or(false)
}

pub fn allow(store: &str, private: bool, host: &str, fingerprint: &str, errors: &[String]) {
    if requires_secure_transport(host, store, private) {
        return;
    }
    with_policy(store, private, |p| {
        p.allow(host, fingerprint, errors, now_seconds())
    });
}

pub fn bypassed_errors(
    store: &str,
    private: bool,
    host: &str,
    fingerprint: Option<&str>,
) -> Option<Vec<String>> {
    with_policy(store, private, |p| p.bypassed_errors(host, fingerprint)).flatten()
}

pub fn note_transport_security(
    store: &str,
    private: bool,
    header: &str,
    host: &str,
    fingerprint: Option<&str>,
) {
    let name = normalized_host(host);
    if name.is_empty() || super::page_text::is_ip_address(&name) {
        return;
    }
    let now = now_seconds();
    let changed = with_policy(store, private, |p| {
        p.note_header(header, &name, fingerprint, now)
            .then(|| p.saved(now))
    })
    .flatten();
    let (Some(entries), false, Some(dir)) = (changed, private, chromium_dir()) else {
        return;
    };
    let file = transport_file(&dir, store);
    let spawned = std::thread::Builder::new()
        .name("ardia-webkit-hsts".into())
        .spawn(move || {
            let Ok(data) = serde_json::to_vec(&entries) else {
                return;
            };
            if let Some(parent) = file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let partial = file.with_extension("json.partial");
            if std::fs::write(&partial, data).is_ok() {
                let _ = std::fs::rename(&partial, &file);
            }
        });
    if let Err(problem) = spawned {
        log::debug!("the HSTS list wasn't saved: {problem}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsts_headers_parse_like_the_old_app() {
        assert_eq!(
            parse_header("max-age=31536000; includeSubDomains"),
            Some((31_536_000.0, true))
        );
        assert_eq!(parse_header("max-age=\"10\""), Some((10.0, false)));
        assert_eq!(parse_header("max-age=10; max-age=20"), None);
        assert_eq!(parse_header("includeSubDomains"), None);
        assert_eq!(parse_header("max-age=-1"), None);
        assert_eq!(
            parse_header("max-age=999999999").map(|p| p.0),
            Some(MAX_AGE_LIMIT)
        );
    }

    #[test]
    fn exceptions_and_transport_security() {
        let mut policy = Policy::default();
        let errors = vec!["authorityInvalid".to_owned()];
        policy.allow("A.com", "FP", &errors, 0.0);
        assert!(policy.has_exception("a.com", 1.0));
        assert!(policy.admits("a.com", "FP", &errors, 1.0));
        assert_eq!(
            policy.bypassed_errors("a.com", Some("FP")),
            Some(errors.clone())
        );
        assert!(!policy.admits("a.com", "FP", &["revoked".to_owned()], 1.0));
        assert!(!policy.admits("a.com", "FP", &errors, EXCEPTION_LIFETIME + 1.0));
        policy.allow("b.com", "FP", &["revoked".to_owned()], 0.0);
        assert!(!policy.has_exception("b.com", 1.0));
        assert!(policy.note_header("max-age=100; includeSubDomains", "c.com", None, 0.0));
        assert!(policy.requires_https("x.c.com", 50.0));
        assert!(!policy.requires_https("x.c.com", 150.0));
        assert!(policy.note_header("max-age=0", "c.com", None, 1.0));
        assert!(!policy.requires_https("c.com", 2.0));
    }

    #[test]
    fn host_lists_binary_search() {
        let list = HostList::new(b"a.com\nb.org\nz.net".to_vec());
        assert!(list.contains("b.org"));
        assert!(list.contains("z.net"));
        assert!(!list.contains("c.com"));
        let preloaded = Preloaded {
            subdomains: HostList::new(b"example.org".to_vec()),
            exact: HostList::new(b"only.com".to_vec()),
        };
        assert!(preloaded.requires_https("deep.example.org"));
        assert!(preloaded.requires_https("only.com"));
        assert!(!preloaded.requires_https("sub.only.com"));
        assert_eq!(
            transport_file(Path::new("/d"), "ab"),
            PathBuf::from("/d/WebKit Transport Security/p6162.json")
        );
    }
}
