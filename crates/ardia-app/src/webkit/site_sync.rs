use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ardia_state::TabId;
use ardia_state::model::PageEngine;
use ardia_state::settings::{EngineMode, Settings};
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use parking_lot::Mutex;

use super::site_data::{
    self, Ledger, PageCookie, bare_domain, host_of_origin, needs_carry, site_of_host, touch,
    web_origin, with_ledger,
};
use super::site_gate;
use super::telemetry::{self, SiteDataCarry, SiteDataSkip};
use crate::coordinator::AppCoordinator;

pub const PUSH_DELAY: Duration = Duration::from_millis(400);
pub const SETTLE_PUSH: Duration = Duration::from_millis(3_000);
pub const CHANGE_DEBOUNCE: Duration = Duration::from_millis(300);
pub const UNDER_WAY_POLL: Duration = Duration::from_millis(50);
pub const MAX_CHANGED_DOMAINS: usize = 200;
pub const MAX_KNOWN_SITES: usize = 20;

pub type Prints = BTreeMap<String, u64>;

pub fn fingerprints(cookies: &[PageCookie]) -> Prints {
    let mut sorted: Vec<&PageCookie> = cookies.iter().collect();
    sorted.sort_by(|a, b| {
        (a.domain.as_str(), a.name.as_str(), a.path.as_str()).cmp(&(
            b.domain.as_str(),
            b.name.as_str(),
            b.path.as_str(),
        ))
    });
    let mut hashers: BTreeMap<String, DefaultHasher> = BTreeMap::new();
    for cookie in sorted {
        let domain = cookie.domain.trim_matches('.').to_lowercase();
        let hasher = hashers.entry(domain).or_default();
        cookie.name.hash(hasher);
        cookie.path.hash(hasher);
        cookie.value.hash(hasher);
        let minutes = if cookie.expires > 0.0 {
            (cookie.expires / 60.0).floor() as i64
        } else {
            -1
        };
        minutes.hash(hasher);
    }
    hashers
        .into_iter()
        .map(|(domain, hasher)| (domain, hasher.finish()))
        .collect()
}

pub fn changed_domains(was: &Prints, now: &Prints) -> Vec<String> {
    let all: std::collections::BTreeSet<&String> = was.keys().chain(now.keys()).collect();
    all.into_iter()
        .filter(|domain| was.get(*domain) != now.get(*domain))
        .take(MAX_CHANGED_DOMAINS)
        .cloned()
        .collect()
}

pub fn known_sites(ledger: &Ledger, profile: &str, sites: &[String]) -> Vec<String> {
    let Some(p) = ledger.get(profile) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    let mut add = |site: &str| {
        if !found.iter().any(|known| known == site) {
            found.push(site.to_owned());
        }
    };
    for site in sites {
        if p.sites.contains_key(site) {
            add(site);
        }
        for (name, entry) in &p.sites {
            if entry.at.get(PageEngine::Webkit).is_some() && entry.hops.contains(site) {
                add(name);
            }
        }
    }
    found.truncate(MAX_KNOWN_SITES);
    found
}

pub fn webkit_in_use(settings: &Settings, ledger: &Ledger, profile: &str) -> bool {
    settings.engine_mode == EngineMode::Webkit
        || settings
            .website_engines
            .values()
            .any(|engine| *engine == PageEngine::Webkit)
        || ledger.get(profile).is_some_and(|p| {
            p.sites
                .values()
                .any(|entry| entry.at.get(PageEngine::Webkit).is_some())
        })
}

#[derive(Default)]
struct SyncState {
    hooked: bool,
    next_timer: u64,
    timers: HashMap<String, u64>,
    snapshots: HashMap<String, Prints>,
    generations: HashMap<String, u64>,
    refreshing: HashSet<String>,
    tab_urls: HashMap<TabId, String>,
}

static SYNC: Mutex<Option<SyncState>> = Mutex::new(None);

fn with_sync<T>(run: impl FnOnce(&mut SyncState) -> T) -> T {
    let mut guard = SYNC.lock();
    run(guard.get_or_insert_with(SyncState::default))
}

fn sleeper(delay: Duration) -> oneshot::Receiver<()> {
    let (done, wait) = oneshot::channel();
    let _ = std::thread::Builder::new()
        .name("ardia-site-sync-timer".into())
        .spawn(move || {
            std::thread::sleep(delay);
            let _ = done.send(());
        });
    wait
}

pub fn until_carried(key: String) -> LocalBoxFuture<'static, SiteDataCarry> {
    async move {
        let began = Instant::now();
        while site_data::carry_under_way(&key) && began.elapsed() < site_data::CARRY_DEADLINE {
            let _ = sleeper(UNDER_WAY_POLL).await;
        }
        SiteDataCarry::default()
    }
    .boxed_local()
}

fn carry_key(profile: &str, site: &str, to: PageEngine) -> String {
    format!("{profile}|{site}|{to:?}")
}

impl AppCoordinator {
    fn site_sync_later(&self, delay: Duration, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-site-sync".into())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(coordinator) = me.upgrade() {
                    coordinator.post(job);
                }
            });
        if let Err(problem) = spawned {
            log::debug!("a site data timer didn't start: {problem}");
        }
    }

    pub(crate) fn sync_site_data_watch(&self) {
        site_gate::set_watching(self.offers_webkit() && self.carries_site_data());
        let first = with_sync(|sync| !std::mem::replace(&mut sync.hooked, true));
        if !first {
            return;
        }
        let me = self.weak();
        site_gate::set_hook(Some(Arc::new(
            move |id: String, profile: String, origin: String| {
                let Some(coordinator) = me.upgrade() else {
                    return;
                };
                let deadline_id = id.clone();
                coordinator.site_sync_later(site_gate::GATE_DEADLINE, move |_| {
                    site_gate::release(&deadline_id)
                });
                coordinator.post(move |c| c.on_site_gate(id, profile, origin));
            },
        )));
    }

    fn on_site_gate(&self, id: String, profile: String, origin: String) {
        let Some(me) = self.weak().upgrade() else {
            site_gate::release(&id);
            return;
        };
        self.watch_webkit_cookies(&profile);
        let began = Instant::now();
        let prepare = self.prepare_webkit_load(profile, origin);
        self.spawn(async move {
            match prepare.await {
                Some(carry) => {
                    let left = site_gate::CARRY_DEADLINE.saturating_sub(began.elapsed());
                    let done = site_data::with_deadline(carry.map(|_| true), left, false).await;
                    telemetry::note_site_data_gate(
                        began.elapsed().as_secs_f64() * 1000.0,
                        true,
                        !done,
                    );
                }
                None => telemetry::note_site_data_gate(0.0, false, false),
            }
            log::debug!(
                "a WebKit load waited {:?} for its site data",
                began.elapsed()
            );
            drop(me);
            site_gate::release(&id);
        });
    }

    fn prepare_webkit_load(
        &self,
        profile: String,
        origin: String,
    ) -> LocalBoxFuture<'static, Option<LocalBoxFuture<'static, SiteDataCarry>>> {
        let Some(me) = self.weak().upgrade() else {
            return futures::future::ready(None).boxed_local();
        };
        if !self.carries_site_data() || web_origin(&origin).is_none() {
            return futures::future::ready(None).boxed_local();
        }
        let host = host_of_origin(&origin);
        let learn = self.learn_domains(vec![host.clone()]);
        async move {
            learn.await;
            if !site_data::knows_host(&host) {
                telemetry::note_site_data_skip(SiteDataSkip::SiteUnresolved);
            }
            let site = site_of_host(&host);
            if site.is_empty() {
                return None;
            }
            let data_dir = me.config().data_dir.clone();
            let open = me.open_in(&profile, &site, PageEngine::Chromium);
            let wanted = with_ledger(data_dir.as_deref(), |ledger| {
                let entry = ledger.get(&profile).and_then(|p| p.sites.get(&site));
                needs_carry(entry, PageEngine::Webkit, open)
            });
            if !wanted {
                let changed = with_ledger(data_dir.as_deref(), |ledger| {
                    touch(
                        ledger,
                        &profile,
                        &site,
                        PageEngine::Webkit,
                        site_data::now_ms(),
                        Some(&origin),
                    )
                });
                if changed {
                    site_data::save_soon();
                }
                return None;
            }
            Some(me.carry_site(profile, site, PageEngine::Webkit, Some(origin)))
        }
        .boxed_local()
    }

    pub(crate) fn carry_soon(&self, profile: &str, site: &str, to: PageEngine, delay: Duration) {
        let key = carry_key(profile, site, to);
        let id = with_sync(|sync| {
            sync.next_timer += 1;
            let id = sync.next_timer;
            sync.timers.insert(key.clone(), id);
            id
        });
        let profile = profile.to_owned();
        let site = site.to_owned();
        self.site_sync_later(delay, move |c| {
            let due = with_sync(|sync| {
                if sync.timers.get(&key) == Some(&id) {
                    sync.timers.remove(&key);
                    true
                } else {
                    false
                }
            });
            if !due {
                return;
            }
            if let Some(me) = c.weak().upgrade() {
                log::debug!("carrying {site}'s sign-ins to {to:?} in the background");
                let carry = me.carry_site(profile, site, to, None);
                c.spawn(async move {
                    carry.await;
                });
            }
        });
    }

    pub(crate) fn note_webkit_page_settled(
        &self,
        tab: &TabId,
        url: &str,
        committed: &str,
        loading: bool,
    ) {
        if loading || url != committed || !self.carries_site_data() {
            return;
        }
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
        let profile = state.engine_profile(&listed.profile_id);
        log::trace!("{tab} settled on {origin} in {profile:?}");
        self.watch_webkit_cookies(&profile);
        let host = host_of_origin(&origin);
        let learn = self.learn_domains(vec![host.clone()]);
        let me = self.weak();
        self.spawn(async move {
            learn.await;
            let site = site_of_host(&host);
            if let Some(me) = me.upgrade()
                && !site.is_empty()
            {
                me.carry_soon(&profile, &site, PageEngine::Chromium, SETTLE_PUSH);
            }
        });
    }

    pub(crate) fn note_chromium_address(&self, tab: &TabId, url: &str) {
        let fresh = with_sync(|sync| {
            if sync.tab_urls.get(tab).map(String::as_str) == Some(url) {
                false
            } else {
                sync.tab_urls.insert(tab.clone(), url.to_owned());
                true
            }
        });
        if !fresh || !self.carries_site_data() {
            return;
        }
        let state = self.store().snapshot();
        with_sync(|sync| sync.tab_urls.retain(|t, _| state.tab(t.as_str()).is_some()));
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        if listed.is_incognito() {
            return;
        }
        let Some(origin) = web_origin(url) else {
            return;
        };
        let profile = state.engine_profile(&listed.profile_id);
        let data_dir = self.config().data_dir.clone();
        let in_use = with_ledger(data_dir.as_deref(), |ledger| {
            webkit_in_use(&state.settings, ledger, &profile)
        });
        if !in_use {
            return;
        }
        let host = host_of_origin(&origin);
        let learn = self.learn_domains(vec![host.clone()]);
        let me = self.weak();
        self.spawn(async move {
            learn.await;
            let site = site_of_host(&host);
            if let Some(me) = me.upgrade()
                && !site.is_empty()
            {
                me.carry_soon(&profile, &site, PageEngine::Webkit, SETTLE_PUSH);
            }
        });
    }

    fn settle_webkit_cookies(&self, profile: String, generation: u64, now: Prints, announce: bool) {
        let changed = with_sync(|sync| {
            if sync.generations.get(&profile).copied().unwrap_or(0) != generation {
                return None;
            }
            let was = sync.snapshots.insert(profile.clone(), now.clone());
            match (announce, was) {
                (true, Some(was)) => Some(changed_domains(&was, &now)),
                _ => None,
            }
        });
        if let Some(domains) = changed.filter(|d| !d.is_empty()) {
            log::debug!("WebKit cookies changed for {} domains", domains.len());
            self.on_site_cookies_changed(profile, domains);
        }
    }

    fn on_site_cookies_changed(&self, profile: String, domains: Vec<String>) {
        if !self.carries_site_data() {
            return;
        }
        let bare: Vec<String> = domains.iter().map(|d| bare_domain(d)).collect();
        let learn = self.learn_domains(bare.clone());
        let me = self.weak();
        self.spawn(async move {
            learn.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            let data_dir = me.config().data_dir.clone();
            let resolved: Vec<String> = bare.iter().map(|domain| site_of_host(domain)).collect();
            let sites = with_ledger(data_dir.as_deref(), |ledger| {
                known_sites(ledger, &profile, &resolved)
            });
            log::trace!("{bare:?} changed in {profile:?}, pushing {sites:?}");
            for site in sites {
                me.carry_soon(&profile, &site, PageEngine::Chromium, PUSH_DELAY);
            }
        });
    }

    pub(crate) fn watch_webkit_cookies(&self, profile: &str) {
        if site_gate::private_profile(profile) {
            return;
        }
        if native::watch(self.weak(), profile) {
            self.refresh_webkit_cookies(profile.to_owned(), false);
        }
    }

    fn cookies_changed_in(&self, profile: String) {
        let first = with_sync(|sync| sync.refreshing.insert(profile.clone()));
        if !first {
            return;
        }
        self.site_sync_later(CHANGE_DEBOUNCE, move |c| {
            with_sync(|sync| sync.refreshing.remove(&profile));
            c.refresh_webkit_cookies(profile, true);
        });
    }

    fn refresh_webkit_cookies(&self, profile: String, announce: bool) {
        let generation = with_sync(|sync| sync.generations.get(&profile).copied().unwrap_or(0));
        let me = self.weak();
        let reading = profile.clone();
        native::read_all(&reading, move |cookies| {
            let spawned = std::thread::Builder::new()
                .name("ardia-cookie-fingerprints".into())
                .spawn(move || {
                    let now = fingerprints(&cookies);
                    if let Some(coordinator) = me.upgrade() {
                        coordinator.post(move |c| {
                            c.settle_webkit_cookies(profile, generation, now, announce)
                        });
                    }
                });
            if let Err(problem) = spawned {
                log::debug!("cookie fingerprints didn't start: {problem}");
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Weak;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_web_kit::{WKHTTPCookieStore, WKHTTPCookieStoreObserver};

    use crate::coordinator::AppCoordinator;
    use crate::webkit::site_data::{PageCookie, native as cookies};

    pub struct WatchIvars {
        coordinator: Weak<AppCoordinator>,
        stores: RefCell<HashMap<usize, (String, Retained<WKHTTPCookieStore>)>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiWebKitCookieWatch"]
        #[ivars = WatchIvars]
        pub struct CookieWatch;

        unsafe impl NSObjectProtocol for CookieWatch {}

        unsafe impl WKHTTPCookieStoreObserver for CookieWatch {
            #[unsafe(method(cookiesDidChangeInCookieStore:))]
            unsafe fn changed(&self, cookie_store: &WKHTTPCookieStore) {
                let key = cookie_store as *const WKHTTPCookieStore as usize;
                let profile = self
                    .ivars()
                    .stores
                    .borrow()
                    .get(&key)
                    .map(|(profile, _)| profile.clone());
                if let (Some(profile), Some(coordinator)) =
                    (profile, self.ivars().coordinator.upgrade())
                {
                    coordinator.cookies_changed_in(profile);
                }
            }
        }
    );

    thread_local! {
        static WATCH: RefCell<Option<Retained<CookieWatch>>> = const { RefCell::new(None) };
    }

    fn watcher(coordinator: Weak<AppCoordinator>) -> Option<Retained<CookieWatch>> {
        let mtm = MainThreadMarker::new()?;
        Some(WATCH.with(|watch| {
            watch
                .borrow_mut()
                .get_or_insert_with(|| {
                    let this = CookieWatch::alloc(mtm).set_ivars(WatchIvars {
                        coordinator,
                        stores: RefCell::new(HashMap::new()),
                    });
                    unsafe { msg_send![super(this), init] }
                })
                .clone()
        }))
    }

    pub fn watch(coordinator: Weak<AppCoordinator>, profile: &str) -> bool {
        let Some(cookie_store) = cookies::cookie_store(profile) else {
            return false;
        };
        let Some(watch) = watcher(coordinator) else {
            return false;
        };
        let key = Retained::as_ptr(&cookie_store) as usize;
        if watch.ivars().stores.borrow().contains_key(&key) {
            return false;
        }
        unsafe { cookie_store.addObserver(ProtocolObject::from_ref(&*watch)) };
        watch
            .ivars()
            .stores
            .borrow_mut()
            .insert(key, (profile.to_owned(), cookie_store));
        true
    }

    pub fn read_all(profile: &str, done: impl FnOnce(Vec<PageCookie>) + 'static) {
        match cookies::cookie_store(profile) {
            Some(cookie_store) => cookies::every_cookie(&cookie_store, done),
            None => done(Vec::new()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod native {
    use std::sync::Weak;

    use crate::coordinator::AppCoordinator;
    use crate::webkit::site_data::PageCookie;

    pub fn watch(_: Weak<AppCoordinator>, _: &str) -> bool {
        false
    }

    pub fn read_all(_: &str, done: impl FnOnce(Vec<PageCookie>) + 'static) {
        done(Vec::new());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webkit::site_data::SiteEntry;

    fn cookie(domain: &str, name: &str, value: &str) -> PageCookie {
        serde_json::from_value(serde_json::json!({
            "name": name, "value": value, "domain": domain, "path": "/", "expires": 1_900_000_000.0
        }))
        .expect("cookie")
    }

    #[test]
    fn fingerprints_group_by_bare_domain_and_notice_value_changes() {
        let before = fingerprints(&[
            cookie(".example.com", "sid", "a"),
            cookie("example.com", "lang", "en"),
            cookie("other.test", "x", "1"),
        ]);
        assert_eq!(before.len(), 2);
        let reordered = fingerprints(&[
            cookie("other.test", "x", "1"),
            cookie("example.com", "lang", "en"),
            cookie(".example.com", "sid", "a"),
        ]);
        assert_eq!(before, reordered);
        let after = fingerprints(&[
            cookie(".example.com", "sid", "b"),
            cookie("example.com", "lang", "en"),
            cookie("other.test", "x", "1"),
        ]);
        assert_eq!(
            changed_domains(&before, &after),
            vec!["example.com".to_owned()]
        );
        let dropped = fingerprints(&[cookie("example.com", "lang", "en")]);
        assert_eq!(
            changed_domains(&before, &dropped),
            vec!["example.com".to_owned(), "other.test".to_owned()]
        );
    }

    #[test]
    fn changed_cookies_push_the_sites_the_ledger_knows() {
        let mut ledger = Ledger::new();
        let profile = ledger.entry("p".into()).or_default();
        profile
            .sites
            .insert("example.com".into(), SiteEntry::default());
        let mut hopped = SiteEntry::default();
        hopped.at.set(PageEngine::Webkit, 5.0);
        hopped.hops.push("auth.test".into());
        profile.sites.insert("app.test".into(), hopped);
        assert_eq!(
            known_sites(&ledger, "p", &["example.com".into()]),
            vec!["example.com".to_owned()]
        );
        assert_eq!(
            known_sites(&ledger, "p", &["auth.test".into()]),
            vec!["app.test".to_owned()]
        );
        assert!(known_sites(&ledger, "q", &["example.com".into()]).is_empty());
    }

    #[test]
    fn webkit_counts_as_in_use_like_the_old_app() {
        let mut settings = Settings::default();
        let mut ledger = Ledger::new();
        assert!(!webkit_in_use(&settings, &ledger, "p"));
        settings
            .website_engines
            .insert("https://a.test".into(), PageEngine::Webkit);
        assert!(webkit_in_use(&settings, &ledger, "p"));
        settings.website_engines.clear();
        let mut entry = SiteEntry::default();
        entry.at.set(PageEngine::Webkit, 1.0);
        ledger
            .entry("p".into())
            .or_default()
            .sites
            .insert("a.test".into(), entry);
        assert!(webkit_in_use(&settings, &ledger, "p"));
        settings.engine_mode = EngineMode::Webkit;
        assert!(webkit_in_use(&settings, &Ledger::new(), "z"));
    }
}
