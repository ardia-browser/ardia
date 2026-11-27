pub mod pick;
pub mod scripts;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use ardia_engine::{
    EngineEvent, EngineProfileId, EngineTabId, EngineWindowId, OpenTab, ProfileCommand, Rect,
    TabCommand, WindowCommand,
};
use ardia_state::windows::{Toast, ToastKind};
use ardia_state::{Action, ProfileId, TabId};
use ardia_ui::UiHost as _;
use ardia_ui::host_data::HostTopics;
use ardia_ui::site::model::{
    BlockerList, BlockerStats, ContentBlockerCommand, ContentBlockerView, HiddenElement,
    HiddenList, covers_host, hiding_host, parse_hiding_filter,
};
use futures::FutureExt as _;
use futures::channel::oneshot;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use scripts::{PickerKeys, PickerOp};

pub const OP_SECONDS: Duration = Duration::from_secs(20);
pub const ATTEMPTS: u32 = 40;
pub const RETRY_AFTER: Duration = Duration::from_millis(250);
pub const PAGE_IDLE: Duration = Duration::from_secs(30);
pub const SETTLE_AFTER_LAUNCH: Duration = Duration::from_millis(1500);
pub const INHERIT_ATTEMPTS: u32 = 6;
pub const PAGE_LOAD_LIMIT: Duration = Duration::from_secs(10);
pub const MAX_HIDING_FILTER: usize = 1024;

type ProfileLock = Arc<futures::lock::Mutex<()>>;

#[derive(Default)]
pub struct BlockerBook {
    extension: Option<Option<PathBuf>>,
    loaded: HashMap<EngineProfileId, String>,
    pages: HashMap<EngineProfileId, EngineTabId>,
    windows: HashMap<EngineProfileId, EngineWindowId>,
    locks: HashMap<EngineProfileId, ProfileLock>,
    uses: HashMap<EngineProfileId, u64>,
    default_profile: Option<EngineProfileId>,
    default_settled: bool,
    waiting: Vec<EngineProfileId>,
    view: Option<ContentBlockerView>,
    session: HashMap<ProfileId, Vec<String>>,
    picking: HashSet<TabId>,
    keys: Option<Arc<PickerKeys>>,
    fail_next: bool,
}

impl BlockerBook {
    fn lock_for(&mut self, profile: EngineProfileId) -> ProfileLock {
        Arc::clone(self.locks.entry(profile).or_default())
    }

    pub fn view(&self) -> Option<&ContentBlockerView> {
        self.view.as_ref()
    }

    pub fn is_page(&self, tab: EngineTabId) -> bool {
        self.pages.values().any(|known| *known == tab)
    }

    pub fn is_page_window(&self, window: EngineWindowId) -> bool {
        self.windows.values().any(|known| *known == window)
    }

    fn keys(&mut self) -> Arc<PickerKeys> {
        Arc::clone(self.keys.get_or_insert_with(|| Arc::new(PickerKeys::new())))
    }

    pub fn session_filters(&self, profile: &ProfileId) -> &[String] {
        self.session.get(profile).map_or(&[], Vec::as_slice)
    }
}

pub fn bundled_extension_in(resources: &Path) -> Option<PathBuf> {
    let path = resources.join("Extensions").join("ublock");
    path.join("manifest.json").is_file().then_some(path)
}

pub fn bundled_extension() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    bundled_extension_in(&contents.join("Resources"))
}

pub fn bundled_version(extension: Option<&Path>) -> String {
    let Some(text) =
        extension.and_then(|path| std::fs::read_to_string(path.join("manifest.json")).ok())
    else {
        return String::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
        return String::new();
    };
    ["version_name", "version"]
        .iter()
        .find_map(|key| manifest.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn count(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .map_or(0, |n| n.max(0.0) as u64)
}

pub fn parse_state(read: &Value, version: String) -> Option<ContentBlockerView> {
    let lists = read.get("lists")?.as_array()?;
    let lists: Vec<BlockerList> = lists
        .iter()
        .filter_map(|list| {
            let id = list.get("id")?.as_str()?.to_owned();
            let group = list
                .get("group")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let flag = |key: &str| list.get(key).and_then(Value::as_bool).unwrap_or(false);
            Some(BlockerList {
                title: list
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_owned(),
                category: scripts::category(&id, group).to_owned(),
                enabled: flag("enabled"),
                default_on: flag("defaultOn"),
                filters: count(list.get("filters")),
                failed: flag("failed"),
                id,
            })
        })
        .collect();
    let allowed_hosts = read
        .get("allowedHosts")
        .and_then(Value::as_array)
        .map(|hosts| {
            hosts
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let enabled = read
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(ContentBlockerView {
        enabled,
        version,
        lists,
        allowed_hosts,
        stats: BlockerStats {
            ready: true,
            enabled,
            network_filters: count(read.get("networkFilters")),
            cosmetic_filters: count(read.get("cosmeticFilters")),
            error: None,
        },
    })
}

pub fn webkit_settings(view: &ContentBlockerView) -> Value {
    let lists: Vec<&str> = view
        .lists
        .iter()
        .filter(|list| list.enabled)
        .map(|list| list.id.as_str())
        .collect();
    json!({ "enabled": view.enabled, "lists": lists, "allowedHosts": view.allowed_hosts })
}

pub fn unavailable(version: String, error: String) -> ContentBlockerView {
    ContentBlockerView {
        version,
        stats: BlockerStats {
            error: Some(error),
            ..BlockerStats::default()
        },
        ..ContentBlockerView::default()
    }
}

pub fn hidden_list(host: String, kept: &[String], session: &[String]) -> HiddenList {
    let elements = kept
        .iter()
        .filter_map(|filter| parse_hiding_filter(filter, false))
        .chain(
            session
                .iter()
                .filter_map(|filter| parse_hiding_filter(filter, true)),
        )
        .filter(|element| covers_host(&element.host, &host))
        .collect();
    HiddenList { host, elements }
}

pub fn hiding_filter(host: &str, selector: &str) -> Option<String> {
    let filter = format!("{host}##{}", selector.trim());
    (filter.len() <= MAX_HIDING_FILTER
        && parse_hiding_filter(&filter, false).is_some()
        && in_picker_grammar(selector.trim()))
    .then_some(filter)
}

fn in_picker_grammar(selector: &str) -> bool {
    let mut chars = selector.chars().peekable();
    let mut plain = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let mut hex = 0;
            while hex < 6 && chars.peek().is_some_and(char::is_ascii_hexdigit) {
                chars.next();
                hex += 1;
            }
            if hex > 0 {
                if chars.peek() == Some(&' ') {
                    chars.next();
                }
            } else if chars
                .next()
                .is_none_or(|c| matches!(c, '\n' | '\r' | '\x0c'))
            {
                return false;
            }
            plain.push('a');
        } else {
            plain.push(c);
        }
    }
    let mut rest = plain.as_str();
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('[') {
            let Some(end) = after.find(']') else {
                return false;
            };
            let inside = &after[..end];
            let Some((name, value)) = inside.split_once("=\"") else {
                return false;
            };
            let ok_name = !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
            let ok_value = value
                .strip_suffix('"')
                .is_some_and(|value| !value.contains(['"', '\\']));
            if !ok_name || !ok_value {
                return false;
            }
            rest = &after[end + 1..];
        } else if let Some(after) = rest.strip_prefix(":nth-of-type(") {
            let Some(end) = after.find(')') else {
                return false;
            };
            if end == 0 || !after[..end].chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
            rest = &after[end + 1..];
        } else {
            let Some(c) = rest.chars().next() else { break };
            if !(c.is_alphanumeric()
                || matches!(c, '-' | '_' | '.' | '#' | '>' | ' ')
                || u32::from(c) >= 0x80)
            {
                return false;
            }
            rest = &rest[c.len_utf8()..];
        }
    }
    true
}

pub fn savable_picked_selector(selector: &str) -> Option<String> {
    if selector.contains(['\r', '\n', '\x0c']) {
        return None;
    }
    const NAMES: [&str; 6] = [
        "data-testid",
        "data-test-id",
        "data-test",
        "data-qa",
        "data-component",
        "data-module",
    ];
    let mut out = String::with_capacity(selector.len());
    let mut rest = selector;
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let matched = NAMES.iter().find_map(|name| {
            let tail = after.strip_prefix(name)?.strip_prefix("=\"")?;
            let end = tail.find(['"', '\\'])?;
            (tail.as_bytes().get(end) == Some(&b'"') && tail[end + 1..].starts_with(']'))
                .then(|| (*name, &tail[..end], &tail[end + 2..]))
        });
        match matched {
            Some((name, value, tail)) => {
                out.push('[');
                out.push_str(name);
                out.push_str("=\"");
                let mut previous = '\0';
                for c in value.chars() {
                    let escaped = matches!(
                        c,
                        '\x01'..='\x1f' | '\x7f' | '\u{85}' | '\u{2028}' | '\u{2029}' | '{' | '}'
                    ) || (c == '*' && previous == '/');
                    if escaped {
                        out.push_str(&format!("\\{:x} ", u32::from(c)));
                    } else {
                        out.push(c);
                    }
                    previous = c;
                }
                out.push_str("\"]");
                rest = tail;
            }
            None => {
                out.push('[');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Some(out)
}

pub fn delay(duration: Duration) -> oneshot::Receiver<()> {
    let (done, wait) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("ardia-blocker-timer".into())
        .spawn(move || {
            std::thread::sleep(duration);
            let _ = done.send(());
        });
    if spawned.is_err() {
        log::debug!("a content blocker timer didn't start");
    }
    wait
}

fn upgrade(me: &Weak<AppCoordinator>) -> Result<Arc<AppCoordinator>, String> {
    me.upgrade().ok_or_else(|| "unavailable".to_owned())
}

fn tab_on(me: &AppCoordinator, tab: EngineTabId, origin: &str) -> Result<bool, String> {
    let engine = me.engine().ok_or("unavailable")?;
    let info = engine.tab_info(tab).map_err(|_| "closed".to_owned())?;
    if info.closed {
        return Err("closed".into());
    }
    if !info.url.is_empty() && !info.url.starts_with(origin) && !info.loading {
        return Err(format!("not the extension page: {}", info.url));
    }
    Ok(!info.loading && info.url.starts_with(origin))
}

async fn page_loaded(
    me: &Weak<AppCoordinator>,
    tab: EngineTabId,
    origin: &str,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if tab_on(&*upgrade(me)?, tab, origin)? {
            return Ok(());
        }
        if started.elapsed() > PAGE_LOAD_LIMIT {
            return Err("the extension page didn't load".into());
        }
        let _ = delay(Duration::from_millis(50)).await;
    }
}

impl AppCoordinator {
    fn blocker_extension(&self) -> Option<PathBuf> {
        let mut bridge = self.bridge.lock();
        bridge
            .blocker
            .extension
            .get_or_insert_with(bundled_extension)
            .clone()
    }

    fn blocker_default_profile(&self) -> Option<EngineProfileId> {
        if let Some(known) = self.bridge.lock().blocker.default_profile {
            return Some(known);
        }
        let id = self.engine()?.default_profile().ok()?;
        self.bridge.lock().blocker.default_profile = Some(id);
        Some(id)
    }

    fn blocker_load(&self, profile: EngineProfileId) -> Result<String, String> {
        if let Some(id) = self.bridge.lock().blocker.loaded.get(&profile) {
            return Ok(id.clone());
        }
        let path = self.blocker_extension().ok_or("not loaded")?;
        let engine = self.engine().ok_or("unavailable")?;
        match engine.load_component_extension(profile, &path.to_string_lossy()) {
            Ok(Some(id)) if !id.is_empty() => {
                if id != scripts::EXTENSION_ID {
                    log::debug!("the content blocker loaded as {id}");
                }
                self.bridge
                    .lock()
                    .blocker
                    .loaded
                    .insert(profile, id.clone());
                Ok(id)
            }
            other => {
                log::warn!("[blocker] component load failed ({other:?})");
                Err("not loaded".into())
            }
        }
    }

    fn blocker_page(
        &self,
        profile: EngineProfileId,
        extension: &str,
    ) -> Result<EngineTabId, String> {
        let engine = self.engine().ok_or("unavailable")?;
        let known = self.bridge.lock().blocker.pages.get(&profile).copied();
        if let Some(tab) = known
            && engine.tab_info(tab).is_ok_and(|info| !info.closed)
        {
            return Ok(tab);
        }
        let window = {
            let existing = self.bridge.lock().blocker.windows.get(&profile).copied();
            match existing.filter(|window| engine.window_info(*window).is_ok()) {
                Some(window) => window,
                None => {
                    let window = engine
                        .create_window(Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 400.0,
                            height: 300.0,
                        })
                        .map_err(|e| e.to_string())?;
                    let _ = engine.window_command(window, WindowCommand::SetInternal { on: true });
                    self.bridge.lock().blocker.windows.insert(profile, window);
                    window
                }
            }
        };
        let tab = engine
            .open_tab(
                window,
                OpenTab {
                    url: format!("{}{}", scripts::origin_of(extension), scripts::PAGE_FILE),
                    profile,
                    foreground: true,
                },
            )
            .map_err(|e| e.to_string())?;
        self.bridge.lock().blocker.pages.insert(profile, tab);
        Ok(tab)
    }

    fn close_blocker_page(&self, profile: EngineProfileId) {
        let tab = self.bridge.lock().blocker.pages.remove(&profile);
        if let (Some(tab), Some(engine)) = (tab, self.engine()) {
            let _ = engine.tab_command(tab, TabCommand::CloseNow);
        }
    }

    fn close_blocker_page_when_idle(&self, profile: EngineProfileId) {
        let use_count = {
            let mut bridge = self.bridge.lock();
            let uses = bridge.blocker.uses.entry(profile).or_default();
            *uses += 1;
            *uses
        };
        let me = self.weak();
        self.spawn(async move {
            let _ = delay(PAGE_IDLE).await;
            let Some(me) = me.upgrade() else {
                return;
            };
            let (unchanged, lock) = {
                let mut bridge = me.bridge.lock();
                let unchanged = bridge.blocker.uses.get(&profile).copied() == Some(use_count);
                (unchanged, bridge.blocker.lock_for(profile))
            };
            if unchanged && let Some(_idle) = lock.try_lock() {
                me.close_blocker_page(profile);
            }
        });
    }

    pub(crate) fn blocker_call(
        &self,
        profile: EngineProfileId,
        expression: String,
        loads_profile: bool,
    ) -> impl std::future::Future<Output = Result<Value, String>> + 'static {
        let me = self.weak();
        let lock = self.bridge.lock().blocker.lock_for(profile);
        async move {
            let _turn = lock.lock().await;
            let deadline = Instant::now() + OP_SECONDS;
            let mut attempts = ATTEMPTS;
            let outcome = loop {
                let coordinator = upgrade(&me)?;
                if !loads_profile
                    && !coordinator
                        .bridge
                        .lock()
                        .blocker
                        .loaded
                        .contains_key(&profile)
                {
                    break Err("profile gone".to_owned());
                }
                let extension = match coordinator.blocker_load(profile) {
                    Ok(id) => id,
                    Err(error) => break Err(error),
                };
                let origin = scripts::origin_of(&extension);
                let tab = match coordinator.blocker_page(profile, &extension) {
                    Ok(tab) => tab,
                    Err(error) => break Err(error),
                };
                drop(coordinator);
                let attempt = match page_loaded(&me, tab, &origin).await {
                    Ok(()) => {
                        let coordinator = upgrade(&me)?;
                        let left = deadline.saturating_duration_since(Instant::now());
                        let fail_next =
                            std::mem::take(&mut coordinator.bridge.lock().blocker.fail_next)
                                && expression != "null";
                        let script = scripts::prelude(
                            fail_next,
                            &extension,
                            left.as_millis() as u64,
                            &expression,
                        );
                        let reply = coordinator
                            .engine()
                            .map(|engine| engine.evaluate_js(tab, &script));
                        drop(coordinator);
                        match reply {
                            None => Err("unavailable".to_owned()),
                            Some(reply) => {
                                let mut reply = reply.fuse();
                                let mut limit = delay(left + Duration::from_secs(2)).fuse();
                                futures::select! {
                                    answer = reply => answer.map_err(|e| e.to_string()).and_then(scripts::answer),
                                    _ = limit => Err("the call timed out".to_owned()),
                                }
                            }
                        }
                    }
                    Err(error) => Err(error),
                };
                match attempt {
                    Ok(value) => break Ok(value),
                    Err(error) => {
                        let coordinator = upgrade(&me)?;
                        let on_own_page = tab_on(&coordinator, tab, &origin).unwrap_or(false)
                            || error.contains("uBlock Origin");
                        let loaded = coordinator
                            .bridge
                            .lock()
                            .blocker
                            .loaded
                            .contains_key(&profile);
                        coordinator.close_blocker_page(profile);
                        drop(coordinator);
                        if attempts > 0
                            && Instant::now() < deadline
                            && loaded
                            && scripts::retriable(&error, on_own_page)
                        {
                            attempts -= 1;
                            let _ = delay(RETRY_AFTER).await;
                            continue;
                        }
                        break Err(error);
                    }
                }
            };
            if let Some(coordinator) = me.upgrade() {
                if let Err(error) = &outcome {
                    log::info!("[blocker] profile {profile}: {error}");
                }
                coordinator.close_blocker_page_when_idle(profile);
            }
            outcome
        }
    }

    pub(crate) fn content_blocker_profile_loaded(&self, profile: &ProfileId, id: EngineProfileId) {
        if profile.is_incognito() {
            return;
        }
        let already = self.bridge.lock().blocker.loaded.contains_key(&id);
        if already {
            return;
        }
        let is_default = self.blocker_default_profile() == Some(id);
        let launching = !self.bridge.lock().blocker.default_settled;
        let engine = self.engine();
        let hold = !is_default && !launching;
        let extension = match self.blocker_load(id) {
            Ok(extension) => extension,
            Err(error) => {
                if is_default {
                    self.blocker_default_settled();
                }
                log::info!("[blocker] the content blocker didn't load into {profile}: {error}");
                return;
            }
        };
        if hold && let Some(engine) = engine.as_ref() {
            let _ = engine.profile_command(
                id,
                ProfileCommand::HoldNavigationsUntilRulesetsOf {
                    extension_id: extension,
                },
            );
        }
        if !is_default {
            if launching {
                self.bridge.lock().blocker.waiting.push(id);
            } else {
                self.inherit_default(id, 0, hold);
            }
            return;
        }
        let me = self.weak();
        let warm = self.blocker_call(id, "null".into(), true);
        self.spawn(async move {
            let _ = delay(SETTLE_AFTER_LAUNCH).await;
            let _ = warm.await;
            if let Some(me) = me.upgrade() {
                me.blocker_default_settled();
            }
        });
    }

    fn blocker_default_settled(&self) {
        let waiting = {
            let mut bridge = self.bridge.lock();
            if bridge.blocker.default_settled {
                return;
            }
            bridge.blocker.default_settled = true;
            std::mem::take(&mut bridge.blocker.waiting)
        };
        for profile in waiting {
            self.inherit_default(profile, 0, false);
        }
        self.refresh_content_blocker();
    }

    fn inherit_default(&self, profile: EngineProfileId, attempt: u32, held: bool) {
        let me = self.weak();
        let follow = self.follow_default(Some(vec![profile]));
        self.spawn(async move {
            let error = follow.await.err();
            let Some(me) = me.upgrade() else {
                return;
            };
            if held
                && attempt == 0
                && let Some(engine) = me.engine()
            {
                let command = match &error {
                    None => ProfileCommand::ReleaseNavigationHoldReady,
                    Some(error) => ProfileCommand::ReleaseNavigationHold {
                        reason: format!("the default profile's settings didn't apply: {error}"),
                    },
                };
                let _ = engine.profile_command(profile, command);
            }
            let gone = !me.bridge.lock().blocker.loaded.contains_key(&profile);
            match error {
                Some(_) if !gone && attempt + 1 < INHERIT_ATTEMPTS => {
                    let _ = delay(Duration::from_secs(1 << attempt)).await;
                    me.inherit_default(profile, attempt + 1, false);
                }
                Some(error) if !gone => {
                    log::warn!(
                        "[blocker] a profile didn't take the default profile's settings: {error}"
                    )
                }
                _ => {}
            }
        });
    }

    fn follow_default(
        &self,
        profiles: Option<Vec<EngineProfileId>>,
    ) -> impl std::future::Future<Output = Result<(), String>> + 'static {
        let me = self.weak();
        let default = self.blocker_default_profile();
        let profiles: Vec<EngineProfileId> =
            profiles.unwrap_or_else(|| self.bridge.lock().blocker.loaded.keys().copied().collect());
        let profiles: Vec<EngineProfileId> = profiles
            .into_iter()
            .filter(|profile| Some(*profile) != default)
            .collect();
        async move {
            let Some(default) = default else {
                return Err("unavailable".into());
            };
            if profiles.is_empty() {
                return Ok(());
            }
            let read = upgrade(&me)?.blocker_call(default, scripts::READ.into(), true);
            let settings = read.await?;
            if !settings.is_object() {
                return Err("no settings to copy".into());
            }
            let mut failed = None;
            for profile in profiles {
                let follow = upgrade(&me)?.blocker_call(
                    profile,
                    scripts::script_with(scripts::FOLLOW, std::slice::from_ref(&settings)),
                    false,
                );
                if let Err(error) = follow.await
                    && error != "profile gone"
                {
                    failed.get_or_insert(error);
                }
            }
            failed.map_or(Ok(()), Err)
        }
    }

    pub fn content_blocker_view(&self) -> Option<ContentBlockerView> {
        self.bridge.lock().blocker.view.clone()
    }

    pub fn refresh_content_blocker(&self) {
        let Some(default) = self.blocker_default_profile() else {
            return;
        };
        let version = bundled_version(self.blocker_extension().as_deref());
        let read = self.blocker_call(default, scripts::STATE.into(), true);
        let user_filters = self.blocker_call(
            default,
            scripts::with_hiding_rules(crate::webkit::content_rules::user_filters::READ_SCRIPT),
            true,
        );
        let me = self.weak();
        self.spawn(async move {
            let view = match read.await {
                Ok(read) => match parse_state(&read, version.clone()) {
                    Some(view) => {
                        crate::webkit::content_rules::settings_changed(webkit_settings(&view));
                        if let Ok(Value::String(text)) = user_filters.await {
                            crate::webkit::content_rules::user_filters_text(text);
                        }
                        view
                    }
                    None => unavailable(version, "unavailable".into()),
                },
                Err(error) => unavailable(version, error),
            };
            if let Some(me) = me.upgrade() {
                let changed = me.bridge.lock().blocker.view.replace(view.clone()) != Some(view);
                if changed {
                    me.signal.emit(HostTopics::SITE);
                }
            }
        });
    }

    fn blocker_changed(&self, follow: bool) {
        self.refresh_content_blocker();
        if !follow {
            return;
        }
        let follow = self.follow_default(None);
        self.spawn(async move {
            if let Err(error) = follow.await {
                log::warn!("[blocker] the other profiles didn't take the change: {error}");
            }
        });
    }

    fn blocker_default_call(
        &self,
        script: &str,
        args: &[Value],
    ) -> Option<impl std::future::Future<Output = Result<Value, String>> + 'static> {
        let default = self.blocker_default_profile()?;
        Some(self.blocker_call(default, scripts::script_with(script, args), true))
    }

    pub fn content_blocker_command(
        &self,
        command: ContentBlockerCommand,
    ) -> oneshot::Receiver<Result<Value, String>> {
        let (answer, reply) = oneshot::channel();
        let (call, follow) = match &command {
            ContentBlockerCommand::Refresh => {
                self.refresh_content_blocker();
                let _ = answer.send(Ok(Value::Null));
                return reply;
            }
            ContentBlockerCommand::SetEnabled(on) => (
                self.blocker_default_call(scripts::SET_ENABLED, &[json!(on), json!(on)]),
                true,
            ),
            ContentBlockerCommand::SetListEnabled { id, enabled } => (
                self.blocker_default_call(scripts::SET_LIST, &[json!(id), json!(enabled)]),
                true,
            ),
            ContentBlockerCommand::AddList(url) => (
                self.blocker_default_call(scripts::ADD_LIST, &[json!(url)]),
                true,
            ),
            ContentBlockerCommand::RemoveList(id) => (
                self.blocker_default_call(scripts::REMOVE_LIST, &[json!(id)]),
                true,
            ),
            ContentBlockerCommand::SetAllowed { host, allowed } => (
                self.blocker_default_call(
                    scripts::SET_ALLOWED,
                    &[json!(allowed), json!(host.to_ascii_lowercase())],
                ),
                true,
            ),
            ContentBlockerCommand::RemoveAllowed(host) => (
                self.blocker_default_call(
                    scripts::REMOVE_ALLOWED,
                    &[json!(host.to_ascii_lowercase())],
                ),
                true,
            ),
        };
        let Some(call) = call else {
            let _ = answer.send(Err("unavailable".into()));
            return reply;
        };
        let adds_list = matches!(command, ContentBlockerCommand::AddList(_));
        let removes_list = matches!(command, ContentBlockerCommand::RemoveList(_));
        let me = self.weak();
        self.spawn(async move {
            let result = call.await;
            note_blocker_write(adds_list, removes_list, &result);
            if let Some(me) = me.upgrade() {
                me.blocker_changed(follow && result.is_ok());
            }
            let _ = answer.send(result);
        });
        reply
    }

    pub(crate) fn set_site_blocking(&self, tab: &TabId, on: bool) {
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()).cloned() else {
            return;
        };
        let host = ardia_state::omnibox::url::host_of(&current.url).to_ascii_lowercase();
        if host.is_empty() {
            return;
        }
        let asked = self.content_blocker_command(ContentBlockerCommand::SetAllowed {
            host: host.clone(),
            allowed: !on,
        });
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let failed = !matches!(asked.await, Ok(Ok(_)));
            let Some(me) = me.upgrade() else {
                return;
            };
            if failed {
                let now = ardia_state::store::now_ms();
                me.dispatch_quietly(Action::PushToast {
                    window: current.window_id.clone(),
                    toast: Toast {
                        id: now.max(0) as u64,
                        kind: ToastKind::Error,
                        message: format!(
                            "Couldn't Change the Ad Blocker. Blocking on {host} is as it was. Try again."
                        ),
                        action: None,
                        icon: Some("exclamationmark.triangle".into()),
                        created_at: now,
                        expires_at: Some(now + 6_000),
                    },
                });
            } else {
                me.reload(tab, false);
            }
        });
    }

    fn saved_engine_profile(&self, profile: &ProfileId) -> Option<EngineProfileId> {
        let saved = if profile.is_incognito() {
            profile.incognito_original()
        } else {
            profile.clone()
        };
        self.engine_profile(&saved)
    }

    pub(crate) fn hidden_elements_on(
        &self,
        tab: &TabId,
    ) -> Option<impl std::future::Future<Output = Option<HiddenList>> + 'static> {
        let state = self.store.snapshot();
        let current = state.tab(tab.as_str())?;
        let host = hiding_host(&current.url)?;
        let session = self
            .bridge
            .lock()
            .blocker
            .session_filters(&current.profile_id)
            .to_vec();
        let read = self
            .saved_engine_profile(&current.profile_id)
            .map(|profile| {
                self.blocker_call(
                    profile,
                    scripts::with_hiding_rules(scripts::READ_HIDDEN),
                    true,
                )
            });
        Some(async move {
            let kept: Vec<String> = match read {
                Some(read) => read
                    .await
                    .ok()
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default(),
                None => Vec::new(),
            };
            Some(hidden_list(host, &kept, &session))
        })
    }

    fn picker(
        &self,
        tab: &TabId,
        op: PickerOp,
        args: &[Value],
    ) -> Option<ardia_engine::Reply<Option<Value>>> {
        let keys = self.bridge.lock().blocker.keys();
        let engine_tab = self.engine_tab(tab)?;
        Some(
            self.engine()?
                .evaluate_js(engine_tab, &scripts::picker_call(&keys, op, args)),
        )
    }

    fn unhide_in_open_tabs(&self, profile: &ProfileId, elements: &[HiddenElement]) {
        let state = self.store.snapshot();
        let saved = self.saved_engine_profile(profile);
        for tab in state.tabs.values() {
            let Some(host) = hiding_host(&tab.url) else {
                continue;
            };
            if self.saved_engine_profile(&tab.profile_id) != saved {
                continue;
            }
            let selectors: Vec<Value> = elements
                .iter()
                .filter(|element| covers_host(&element.host, &host))
                .map(|element| json!(element.selector))
                .collect();
            if !selectors.is_empty()
                && let Some(reply) =
                    self.picker(&tab.id, PickerOp::Unhide, &[Value::Array(selectors)])
            {
                self.spawn(async move {
                    let _ = reply.await;
                });
            }
        }
    }

    pub(crate) fn restore_hidden(&self, tab: &TabId, filters: Vec<String>) {
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()).cloned() else {
            return;
        };
        let session: HashSet<String> = self
            .bridge
            .lock()
            .blocker
            .session_filters(&current.profile_id)
            .iter()
            .filter(|filter| filters.contains(filter))
            .cloned()
            .collect();
        let elements: Vec<HiddenElement> = filters
            .iter()
            .filter_map(|filter| parse_hiding_filter(filter, session.contains(filter)))
            .collect();
        if !session.is_empty()
            && let Some(kept) = self
                .bridge
                .lock()
                .blocker
                .session
                .get_mut(&current.profile_id)
        {
            kept.retain(|filter| !session.contains(filter));
        }
        self.unhide_in_open_tabs(&current.profile_id, &elements);
        let kept: Vec<String> = filters
            .iter()
            .filter(|filter| !session.contains(*filter))
            .cloned()
            .collect();
        let call = (!kept.is_empty())
            .then(|| self.saved_engine_profile(&current.profile_id))
            .flatten()
            .map(|profile| {
                self.blocker_call(
                    profile,
                    scripts::with_hiding_rules(&scripts::script_with(
                        scripts::RESTORE,
                        &[json!(kept)],
                    )),
                    true,
                )
            });
        let me = self.weak();
        let tab = tab.clone();
        let restoring = elements.len() as u64;
        let restored: Vec<HiddenElement> = elements.into_iter().filter(|e| !e.session).collect();
        self.spawn(async move {
            if let Some(call) = call
                && let Err(error) = call.await
            {
                ardia_telemetry::counts::count("hidden_element_write_failures");
                log::warn!("hidden elements weren't restored: {error}");
            } else {
                ardia_telemetry::counts::add("hidden_elements_restored", restoring);
            }
            let Some(me) = me.upgrade() else {
                return;
            };
            if !restored.is_empty() {
                me.reload_covered_tabs(&current.profile_id, &restored);
            }
            me.hidden_elements_changed_for_settings();
            me.refresh_hidden_elements(&tab);
        });
    }

    pub(crate) fn profile_hidden_filters(
        &self,
        profile: &ProfileId,
    ) -> Option<impl std::future::Future<Output = Result<Vec<String>, String>> + 'static> {
        let engine_profile = self.saved_engine_profile(profile)?;
        let read = self.blocker_call(
            engine_profile,
            scripts::with_hiding_rules(scripts::READ_HIDDEN),
            true,
        );
        Some(async move {
            let value = read.await?;
            Ok(serde_json::from_value::<Vec<String>>(value).unwrap_or_default())
        })
    }

    pub(crate) fn restore_profile_hidden(
        &self,
        profile: &ProfileId,
        filters: Vec<String>,
    ) -> Option<impl std::future::Future<Output = Result<(), String>> + 'static> {
        let engine_profile = self.saved_engine_profile(profile)?;
        let elements: Vec<HiddenElement> = filters
            .iter()
            .filter_map(|filter| parse_hiding_filter(filter, false))
            .collect();
        self.unhide_in_open_tabs(profile, &elements);
        let call = self.blocker_call(
            engine_profile,
            scripts::with_hiding_rules(&scripts::script_with(scripts::RESTORE, &[json!(filters)])),
            true,
        );
        let me = self.weak();
        let profile = profile.clone();
        Some(async move {
            call.await?;
            if let Some(me) = me.upgrade() {
                me.reload_covered_tabs(&profile, &elements);
            }
            Ok(())
        })
    }

    fn reload_covered_tabs(&self, profile: &ProfileId, restored: &[HiddenElement]) {
        let state = self.store.snapshot();
        let saved = self.saved_engine_profile(profile);
        for tab in state.tabs.values() {
            let Some(host) = hiding_host(&tab.url) else {
                continue;
            };
            let covered = restored
                .iter()
                .any(|element| covers_host(&element.host, &host));
            if covered
                && self.saved_engine_profile(&tab.profile_id) == saved
                && self.engine_tab(&tab.id).is_some()
            {
                self.reload(tab.id.clone(), false);
            }
        }
    }

    pub(crate) fn refresh_hidden_elements(&self, tab: &TabId) {
        let Some(read) = self.hidden_elements_on(tab) else {
            self.store_hidden(tab, None);
            return;
        };
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let list = read.await;
            if let Some(me) = me.upgrade() {
                me.store_hidden(&tab, list);
            }
        });
    }

    pub(crate) fn start_hiding_element(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()).cloned() else {
            return;
        };
        let Some(host) = hiding_host(&current.url) else {
            return;
        };
        if self.bridge.lock().blocker.picking.contains(tab) {
            if let Some(reply) = self.picker(tab, PickerOp::Cancel, &[]) {
                self.spawn(async move {
                    let _ = reply.await;
                });
            }
            return;
        }
        if self.reader_status(tab).active {
            self.toggle_reader(tab.clone());
        }
        let Some(engine_tab) = self.engine_tab(tab) else {
            return;
        };
        let documents = self
            .engine()
            .and_then(|engine| engine.tab_info(engine_tab).ok())
            .map_or(0, |info| info.committed_document_count);
        if let Some(engine) = self.engine() {
            let _ = engine.tab_command(engine_tab, TabCommand::Focus);
        }
        let armed = pick::arm();
        let Some(start) = self.picker(tab, PickerOp::Start, &[]) else {
            return;
        };
        self.bridge.lock().blocker.picking.insert(tab.clone());
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            let result = start.await.ok().flatten();
            let Some(me) = me.upgrade() else {
                return;
            };
            me.bridge.lock().blocker.picking.remove(&tab);
            let same_document = me
                .engine_tab(&tab)
                .zip(me.engine())
                .and_then(|(engine_tab, engine)| engine.tab_info(engine_tab).ok())
                .is_some_and(|info| info.committed_document_count == documents);
            let confirmed = pick::take(armed) && same_document;
            me.finish_pick(&tab, &current, &host, result, confirmed);
        });
    }

    fn finish_pick(
        &self,
        tab: &TabId,
        before: &ardia_state::tabs::Tab,
        host: &str,
        result: Option<Value>,
        confirmed: bool,
    ) {
        let offered = result
            .as_ref()
            .and_then(|r| r.get("selector"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let refused = result
            .as_ref()
            .and_then(|r| r.get("refused"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if refused {
            ardia_telemetry::counts::count("element_picks_refused");
        } else if offered.is_some() && !confirmed {
            ardia_telemetry::counts::count("element_picks_unconfirmed");
        }
        let state = self.store.snapshot();
        let same_page = state.tab(tab.as_str()).is_some_and(|now| {
            hiding_host(&now.url).as_deref() == Some(host) && now.profile_id == before.profile_id
        });
        let picked = offered
            .clone()
            .filter(|_| !refused && confirmed && same_page);
        let unhide = |selector: &str| {
            if let Some(reply) = self.picker(tab, PickerOp::Unhide, &[json!([selector])]) {
                self.spawn(async move {
                    let _ = reply.await;
                });
            }
        };
        let Some(picked) = picked else {
            if let Some(offered) = offered {
                unhide(&offered);
            }
            ardia_telemetry::counts::count("element_picker_cancels");
            return;
        };
        let filter =
            savable_picked_selector(&picked).and_then(|savable| hiding_filter(host, &savable));
        let Some(filter) = filter else {
            ardia_telemetry::counts::count("element_picks_unsavable");
            ardia_telemetry::counts::count("element_picker_cancels");
            unhide(&picked);
            return;
        };
        let selector = filter[filter.find("##").map_or(0, |at| at + 2)..].to_owned();
        if selector != picked {
            ardia_telemetry::counts::count("hidden_element_selectors_escaped");
        }
        ardia_telemetry::counts::count("elements_hidden");
        if before.profile_id.is_incognito() {
            ardia_telemetry::counts::count("elements_hidden_private");
        }
        if selector != picked
            && let Some(apply) = self.picker(tab, PickerOp::Apply, &[json!([selector])])
        {
            let me = self.weak();
            let tab = tab.clone();
            self.spawn(async move {
                let _ = apply.await;
                if let Some(me) = me.upgrade()
                    && let Some(reply) = me.picker(&tab, PickerOp::Unhide, &[json!([picked])])
                {
                    let _ = reply.await;
                }
            });
        }
        if before.profile_id.is_incognito() {
            {
                let mut bridge = self.bridge.lock();
                let kept = bridge
                    .blocker
                    .session
                    .entry(before.profile_id.clone())
                    .or_default();
                if !kept.contains(&filter) {
                    kept.push(filter);
                }
            }
            self.refresh_hidden_elements(tab);
            return;
        }
        let Some(profile) = self.saved_engine_profile(&before.profile_id) else {
            return;
        };
        let call = self.blocker_call(
            profile,
            scripts::with_hiding_rules(&scripts::script_with(scripts::HIDE, &[json!([filter])])),
            true,
        );
        let me = self.weak();
        let tab = tab.clone();
        self.spawn(async move {
            if let Err(error) = call.await {
                ardia_telemetry::counts::count("hidden_element_write_failures");
                log::warn!("the hidden element wasn't saved: {error}");
            }
            if let Some(me) = me.upgrade() {
                me.hidden_elements_changed_for_settings();
                me.refresh_hidden_elements(&tab);
            }
        });
    }

    pub(crate) fn note_blocker_event(&self, event: &EngineEvent) {
        match event {
            EngineEvent::LoadingChanged {
                tab,
                loading: false,
            } => self.apply_session_hiding(*tab),
            EngineEvent::WindowClosed { window } => {
                let mut bridge = self.bridge.lock();
                bridge.blocker.windows.retain(|_, known| known != window);
            }
            _ => {}
        }
    }

    fn apply_session_hiding(&self, engine_tab: EngineTabId) {
        let Some(tab) = self.state_tab(engine_tab) else {
            return;
        };
        let state = self.store.snapshot();
        let Some(current) = state.tab(tab.as_str()) else {
            return;
        };
        if !current.profile_id.is_incognito() {
            return;
        }
        let Some(host) = hiding_host(&current.url) else {
            return;
        };
        let session = self
            .bridge
            .lock()
            .blocker
            .session_filters(&current.profile_id)
            .to_vec();
        let selectors: Vec<Value> = session
            .iter()
            .filter_map(|filter| parse_hiding_filter(filter, true))
            .filter(|element| covers_host(&element.host, &host))
            .map(|element| json!(element.selector))
            .collect();
        if !selectors.is_empty()
            && let Some(reply) = self.picker(&tab, PickerOp::Apply, &[Value::Array(selectors)])
        {
            self.spawn(async move {
                let _ = reply.await;
            });
        }
    }

    pub fn set_content_blocker_extension(&self, path: Option<PathBuf>) {
        self.bridge.lock().blocker.extension = Some(path);
    }

    pub fn blocker_fail_next_message(&self) {
        self.bridge.lock().blocker.fail_next = true;
    }
}

fn note_blocker_write(adds_list: bool, removes_list: bool, result: &Result<Value, String>) {
    let failed = match result {
        Ok(value) => value.get("failed").and_then(Value::as_bool) == Some(true),
        Err(_) => true,
    };
    let field = match (adds_list, removes_list, failed) {
        (true, _, true) => "content_blocker_custom_list_add_failures",
        (true, _, false) => "content_blocker_custom_lists_added",
        (_, true, false) => "content_blocker_custom_lists_removed",
        (_, _, true) => "content_blocker_write_failures",
        _ => return,
    };
    ardia_telemetry::counts::count(field);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn state_reads_map_like_the_old_driver() {
        let view = parse_state(
            &json!({
                "lists": [
                    {"id": "easylist", "title": "EasyList", "group": "ads", "enabled": true, "defaultOn": true, "filters": 12, "failed": false},
                    {"id": "fanboy-cookiemonster", "group": "annoyances", "enabled": false},
                    {"title": "no id"}
                ],
                "networkFilters": 900, "cosmeticFilters": 40, "enabled": true,
                "allowedHosts": ["example.com", 3]
            }),
            "1.77.0".into(),
        )
        .expect("a state");
        assert!(view.enabled && view.stats.ready);
        assert_eq!(view.lists.len(), 2);
        assert_eq!(view.lists[1].category, "cookies");
        assert_eq!(view.lists[1].title, "fanboy-cookiemonster");
        assert_eq!(view.allowed_hosts, vec!["example.com".to_owned()]);
        assert_eq!(view.stats.network_filters, 900);
        assert!(view.allows("www.example.com"));
        assert!(parse_state(&json!({}), String::new()).is_none());
        let off = unavailable("v".into(), "not loaded".into());
        assert!(!off.stats.ready && off.stats.error.as_deref() == Some("not loaded"));
    }

    #[test]
    fn hiding_filters_follow_the_picker_grammar() {
        assert_eq!(
            hiding_filter("example.com", " div.ad > span:nth-of-type(2) ").as_deref(),
            Some("example.com##div.ad > span:nth-of-type(2)")
        );
        assert_eq!(
            hiding_filter("example.com", "div[data-testid=\"promo\"]").as_deref(),
            Some("example.com##div[data-testid=\"promo\"]")
        );
        assert!(hiding_filter("example.com", "div:has(.x)").is_none());
        assert!(hiding_filter("example.com", "div { color: red }").is_none());
        assert!(hiding_filter("example.com", "#\\31 23").is_some());
        assert_eq!(
            savable_picked_selector("div[data-qa=\"a{b}\"]").as_deref(),
            Some("div[data-qa=\"a\\7b b\\7d \"]")
        );
        assert_eq!(savable_picked_selector("a\nb"), None);
        let list = hidden_list(
            "news.example.com".into(),
            &["example.com##.ad".into(), "other.org##.ad".into()],
            &["news.example.com##.promo".into()],
        );
        assert_eq!(list.elements.len(), 2);
        assert!(list.elements[1].session);
    }

    #[test]
    fn the_bundled_extension_is_found_under_resources() {
        let root = std::env::temp_dir().join(format!("ardia-blocker-test-{}", std::process::id()));
        let ext = root.join("Extensions").join("ublock");
        std::fs::create_dir_all(&ext).expect("scratch dir");
        assert_eq!(bundled_extension_in(&root), None);
        std::fs::write(ext.join("manifest.json"), r#"{"version": "1.77.0"}"#).expect("manifest");
        assert_eq!(bundled_extension_in(&root), Some(ext.clone()));
        assert_eq!(bundled_version(Some(&ext)), "1.77.0");
        let _ = std::fs::remove_dir_all(&root);
    }
}
