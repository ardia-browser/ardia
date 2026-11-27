use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

pub const WEBKIT_SITE_SETTINGS: [&str; 10] = [
    "camera",
    "microphone",
    "location",
    "notifications",
    "popups",
    "javascript",
    "images",
    "cookies",
    "autoplay",
    "clipboard",
];
pub const ASKED_KINDS: [&str; 4] = ["camera", "microphone", "location", "notifications"];
pub const SITE_RULES: [&str; 6] = [
    "popups",
    "javascript",
    "images",
    "cookies",
    "autoplay",
    "clipboard",
];
pub const SOUND: &str = "sound";
pub const POLICY_KINDS: [&str; 6] = [
    "javascript",
    "images",
    "cookies",
    "autoplay",
    "clipboard",
    "sound",
];

pub const CLIPBOARD_GUARD: &str = r#"(() => {
  const clipboard = navigator.clipboard;
  const proto = clipboard && Object.getPrototypeOf(clipboard);
  if (!proto) return;
  for (const name of ["read", "readText"]) {
    if (typeof proto[name] !== "function") continue;
    Object.defineProperty(proto, name, {
      configurable: true, writable: true,
      value: { [name]() { return Promise.reject(new DOMException("Read permission denied.", "NotAllowedError")); } }[name],
    });
  }
})();"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Autoplay {
    Allow = 1,
    Deny = 3,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SitePolicy {
    pub javascript: bool,
    pub images: bool,
    pub cookies: bool,
    pub clipboard: String,
    pub autoplay: Option<Autoplay>,
}

impl Default for SitePolicy {
    fn default() -> Self {
        Self {
            javascript: true,
            images: true,
            cookies: true,
            clipboard: "ask".into(),
            autoplay: None,
        }
    }
}

impl SitePolicy {
    pub fn from_rules(rules: &Value) -> SitePolicy {
        let rules = rules
            .get("settings")
            .filter(|settings| settings.is_object())
            .unwrap_or(rules);
        let value = |kind: &str| rules.get(kind)?.get("value")?.as_str().map(str::to_owned);
        let chosen = |kind: &str| {
            rules
                .get(kind)
                .and_then(|r| r.get("isDefault"))
                .and_then(Value::as_bool)
                == Some(false)
        };
        let autoplay = if value("autoplay").as_deref() == Some("block") {
            Some(Autoplay::Deny)
        } else if chosen(SOUND) && value(SOUND).as_deref() == Some("allow") {
            Some(Autoplay::Allow)
        } else {
            None
        };
        SitePolicy {
            javascript: value("javascript").as_deref() != Some("block"),
            images: value("images").as_deref() != Some("block"),
            cookies: value("cookies").as_deref() != Some("block"),
            clipboard: value("clipboard").unwrap_or_else(|| "ask".into()),
            autoplay,
        }
    }

    pub fn is_default(&self) -> bool {
        *self == SitePolicy::default()
    }
}

pub fn rule_default(kind: &str) -> &'static str {
    match kind {
        "popups" => "block",
        "clipboard" => "ask",
        _ => "allow",
    }
}

pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(match parsed.port() {
        Some(port) => format!("{}://{host}:{port}", parsed.scheme()),
        None => format!("{}://{host}", parsed.scheme()),
    })
}

pub fn cookie_filter(origin: &str) -> Option<String> {
    let parsed = url::Url::parse(origin).ok()?;
    let host = parsed.host_str()?;
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!(
        "^{}://{}{port}[/?#]",
        parsed.scheme(),
        host.replace('.', "\\.")
    ))
}

pub fn cookie_rule_list(origin: &str) -> Option<String> {
    let filter = cookie_filter(origin)?;
    Some(
        json!([{ "trigger": { "url-filter": filter }, "action": { "type": "block-cookies" } }])
            .to_string(),
    )
}

pub fn cookie_rule_identifier(origin: &str) -> String {
    let mut out = String::from("cookies-");
    for scalar in origin.chars() {
        out.push_str(&format!("{:x}", scalar as u32));
    }
    out
}

#[derive(Default)]
struct Book {
    policies: HashMap<(String, String), SitePolicy>,
    private_choices: HashMap<(String, String, String), bool>,
}

static BOOK: Mutex<Option<Book>> = Mutex::new(None);

fn with_book<T>(run: impl FnOnce(&mut Book) -> T) -> T {
    let mut guard = BOOK.lock();
    run(guard.get_or_insert_with(Book::default))
}

pub fn is_private(profile: &str) -> bool {
    profile.contains('@')
}

fn private_base(profile: &str) -> String {
    profile.split('@').next().unwrap_or(profile).to_owned()
}

pub fn remember_policy(profile: &str, origin: &str, rules: &Value) {
    let policy = SitePolicy::from_rules(rules);
    with_book(|book| {
        let key = (profile.to_owned(), origin.to_owned());
        if policy.is_default() {
            book.policies.remove(&key);
        } else {
            book.policies.insert(key, policy);
        }
    });
}

pub fn policy(profile: &str, origin: &str) -> SitePolicy {
    if is_private(profile) {
        return SitePolicy::from_rules(&Value::Object(private_rules(
            profile,
            origin,
            &POLICY_KINDS,
        )));
    }
    with_book(|book| {
        book.policies
            .get(&(profile.to_owned(), origin.to_owned()))
            .cloned()
            .unwrap_or_default()
    })
}

pub fn private_rules(profile: &str, origin: &str, kinds: &[&str]) -> Map<String, Value> {
    let base = private_base(profile);
    with_book(|book| {
        kinds
            .iter()
            .map(|kind| {
                let answer = book.private_choices.get(&(
                    base.clone(),
                    origin.to_owned(),
                    (*kind).to_owned(),
                ));
                let value = match answer {
                    Some(true) => "allow",
                    Some(false) => "block",
                    None if *kind == SOUND => "allow",
                    None if SITE_RULES.contains(kind) => rule_default(kind),
                    None => "ask",
                };
                (
                    (*kind).to_owned(),
                    json!({ "value": value, "isDefault": answer.is_none() }),
                )
            })
            .collect()
    })
}

pub fn private_settings(profile: &str, origin: &str) -> Value {
    let mut kinds: Vec<&str> = ASKED_KINDS.to_vec();
    kinds.push(SOUND);
    kinds.extend(SITE_RULES);
    Value::Object(private_rules(profile, origin, &kinds))
}

pub fn set_private_choice(profile: &str, origin: &str, kind: &str, value: &str) {
    let key = (private_base(profile), origin.to_owned(), kind.to_owned());
    with_book(|book| match value {
        "allow" => {
            book.private_choices.insert(key, true);
        }
        "block" => {
            book.private_choices.insert(key, false);
        }
        _ => {
            book.private_choices.remove(&key);
        }
    });
}

pub fn end_private_session(base: &str) {
    with_book(|book| {
        book.private_choices
            .retain(|(owner, _, _), _| owner != base)
    });
}

pub fn origins_from(value: &Value) -> Vec<String> {
    let list = value
        .get("origins")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    list.map(|items| {
        items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("origin").and_then(Value::as_str))
                    .map(str::to_owned)
            })
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{MainThreadMarker, MainThreadOnly, Message as _, msg_send};
    use objc2_foundation::{NSNumber, NSString};
    use objc2_web_kit::{
        WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKUserScript,
        WKUserScriptInjectionTime, WKWebView, WKWebpagePreferences,
    };

    use super::*;

    thread_local! {
        static COOKIE_LISTS: RefCell<HashMap<String, Retained<WKContentRuleList>>> = RefCell::new(HashMap::new());
        static ATTACHED: RefCell<HashMap<usize, (usize, Retained<WKContentRuleList>)>> = RefCell::new(HashMap::new());
        static GUARDS: RefCell<HashMap<usize, Retained<WKUserScript>>> = RefCell::new(HashMap::new());
        static RULE_STORE: RefCell<Option<Retained<WKContentRuleListStore>>> = const { RefCell::new(None) };
    }

    fn responds(object: &AnyObject, setter: &str) -> bool {
        let selector =
            objc2::runtime::Sel::register(&std::ffi::CString::new(setter).unwrap_or_default());
        let answer: Bool = unsafe { msg_send![object, respondsToSelector: selector] };
        answer.as_bool()
    }

    fn set_bool(object: &AnyObject, key: &str, setter: &str, value: bool) {
        if !responds(object, setter) {
            return;
        }
        let number = NSNumber::new_bool(value);
        let _: () =
            unsafe { msg_send![object, setValue: &*number, forKey: &*NSString::from_str(key)] };
    }

    fn rule_store() -> Option<Retained<WKContentRuleListStore>> {
        let mtm = MainThreadMarker::new()?;
        RULE_STORE.with(|cell| {
            let mut cell = cell.borrow_mut();
            if cell.is_none() {
                let folder = std::env::temp_dir().join("ArdiaSiteRules");
                let _ = std::fs::create_dir_all(&folder);
                let url = objc2_foundation::NSURL::fileURLWithPath(&NSString::from_str(
                    &folder.to_string_lossy(),
                ));
                *cell = unsafe { WKContentRuleListStore::storeWithURL(Some(&url), mtm) };
            }
            cell.clone()
        })
    }

    fn attach_cookie_block(web: &WKWebView, list: Option<Retained<WKContentRuleList>>) {
        let controller = unsafe { web.configuration().userContentController() };
        let key = Retained::as_ptr(&controller) as usize;
        ATTACHED.with(|attached| {
            let mut attached = attached.borrow_mut();
            let previous = attached.remove(&key);
            if let Some((_, old)) = &previous {
                unsafe { controller.removeContentRuleList(old) };
            }
            if let Some(list) = list {
                unsafe { controller.addContentRuleList(&list) };
                attached.insert(key, (Retained::as_ptr(&list) as usize, list));
            }
        });
    }

    fn set_clipboard_guard(controller: &WKUserContentController, on: bool) {
        let key = controller as *const WKUserContentController as usize;
        GUARDS.with(|guards| {
            let mut guards = guards.borrow_mut();
            let installed = guards.contains_key(&key);
            if installed == on {
                return;
            }
            if on {
                let mtm = MainThreadMarker::from(controller);
                let script = unsafe {
                    WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                        WKUserScript::alloc(mtm),
                        &NSString::from_str(CLIPBOARD_GUARD),
                        WKUserScriptInjectionTime::AtDocumentStart,
                        false,
                    )
                };
                unsafe { controller.addUserScript(&script) };
                guards.insert(key, script);
                return;
            }
            let Some(guard) = guards.remove(&key) else {
                return;
            };
            let kept: Vec<Retained<WKUserScript>> = unsafe { controller.userScripts() }
                .iter()
                .filter(|script| !std::ptr::eq(&**script, &*guard))
                .collect();
            unsafe { controller.removeAllUserScripts() };
            for script in kept {
                unsafe { controller.addUserScript(&script) };
            }
        });
    }

    fn with_cookie_list(
        origin: &str,
        done: impl FnOnce(Option<Retained<WKContentRuleList>>) + 'static,
    ) {
        if let Some(list) = COOKIE_LISTS.with(|lists| lists.borrow().get(origin).cloned()) {
            return done(Some(list));
        }
        let (Some(store), Some(encoded)) = (rule_store(), cookie_rule_list(origin)) else {
            return done(None);
        };
        let identifier = cookie_rule_identifier(origin);
        let origin = origin.to_owned();
        let done = RefCell::new(Some(done));
        let block = block2::RcBlock::new(
            move |list: *mut WKContentRuleList, _error: *mut objc2_foundation::NSError| {
                let list = unsafe { Retained::retain(list) };
                if let Some(list) = &list {
                    COOKIE_LISTS
                        .with(|lists| lists.borrow_mut().insert(origin.clone(), list.clone()));
                }
                if let Some(done) = done.borrow_mut().take() {
                    done(list);
                }
            },
        );
        unsafe {
            store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
                Some(&NSString::from_str(&identifier)),
                Some(&NSString::from_str(&encoded)),
                Some(&block),
            )
        };
    }

    pub fn configure(
        web: &WKWebView,
        preferences: &WKWebpagePreferences,
        profile: &str,
        url: &str,
    ) {
        let Some(origin) = origin_of(url) else {
            return;
        };
        let policy = policy(profile, &origin);
        unsafe { preferences.setAllowsContentJavaScript(policy.javascript) };
        if let Some(autoplay) = policy.autoplay
            && responds(preferences, "_setAutoplayPolicy:")
        {
            let number = NSNumber::new_isize(autoplay as isize);
            let _: () = unsafe {
                msg_send![preferences, setValue: &*number, forKey: &*NSString::from_str("autoplayPolicy")]
            };
        }
        let page = unsafe { web.configuration().preferences() };
        set_bool(
            &page,
            "loadsImagesAutomatically",
            "_setLoadsImagesAutomatically:",
            policy.images,
        );
        let pastes = policy.clipboard == "allow";
        set_bool(
            &page,
            "javaScriptCanAccessClipboard",
            "_setJavaScriptCanAccessClipboard:",
            pastes,
        );
        set_bool(&page, "DOMPasteAllowed", "_setDOMPasteAllowed:", pastes);
        let controller = unsafe { web.configuration().userContentController() };
        set_clipboard_guard(&controller, policy.clipboard == "block");
        if !policy.is_default() {
            crate::webkit::telemetry::note_webkit_count("siteSettingApplied");
        }
        if policy.cookies {
            attach_cookie_block(web, None);
            return;
        }
        let web = web.retain();
        with_cookie_list(&origin, move |list| attach_cookie_block(&web, list));
    }
}

#[cfg(target_os = "macos")]
pub use mac::configure;

impl crate::coordinator::AppCoordinator {
    pub(crate) fn load_webkit_policies(&self) {
        let Some(engine) = self.engine() else {
            return;
        };
        let state = self.store().snapshot();
        for profile in state.profiles.values() {
            let Some(dir) = self.service_profile_dir(&profile.id) else {
                continue;
            };
            let name = profile.engine_profile();
            let listing = ardia_engine::Services::new(engine.as_ref(), &dir)
                .sites()
                .origins();
            let engine = engine.clone();
            self.spawn(async move {
                let Ok(value) = listing.await else {
                    return;
                };
                for origin in origins_from(&value) {
                    let reply = ardia_engine::Services::new(engine.as_ref(), &dir)
                        .sites()
                        .settings(&origin);
                    if let Ok(rules) = reply.await {
                        remember_policy(&name, &origin, &rules);
                    }
                }
            });
        }
    }

    fn webkit_page_profile(&self, tab: &ardia_state::TabId) -> Option<(String, String)> {
        let state = self.store().snapshot();
        let listed = state.tab(tab.as_str())?;
        if ardia_state::engines::tab_engine(&state, tab.as_str())
            != ardia_state::model::PageEngine::Webkit
        {
            return None;
        }
        let origin = origin_of(&listed.url)?;
        Some((state.engine_profile(&listed.profile_id), origin))
    }

    pub(crate) fn remember_webkit_policy(&self, tab: &ardia_state::TabId, rules: &Value) {
        let state = self.store().snapshot();
        let Some(listed) = state.tab(tab.as_str()) else {
            return;
        };
        let Some(origin) = origin_of(&listed.url) else {
            return;
        };
        let profile = state.engine_profile(&listed.profile_id);
        if !is_private(&profile) {
            remember_policy(&profile, &origin, rules);
        }
    }

    pub(crate) fn webkit_private_site_settings(&self, tab: &ardia_state::TabId) -> Option<Value> {
        let (profile, origin) = self.webkit_page_profile(tab)?;
        is_private(&profile).then(|| private_settings(&profile, &origin))
    }

    pub(crate) fn set_webkit_private_site_setting(
        &self,
        tab: &ardia_state::TabId,
        kind: &str,
        value: &str,
    ) -> bool {
        let Some((profile, origin)) = self.webkit_page_profile(tab) else {
            return false;
        };
        if !is_private(&profile) {
            return false;
        }
        set_private_choice(&profile, &origin, kind, value);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policies_follow_the_old_rules() {
        let rules = json!({
            "javascript": { "value": "block", "isDefault": false },
            "sound": { "value": "allow", "isDefault": false },
            "clipboard": { "value": "allow", "isDefault": false }
        });
        let policy = SitePolicy::from_rules(&rules);
        assert!(!policy.javascript);
        assert!(policy.images);
        assert_eq!(policy.autoplay, Some(Autoplay::Allow));
        assert_eq!(policy.clipboard, "allow");
        let blocked = SitePolicy::from_rules(&json!({ "autoplay": { "value": "block" } }));
        assert_eq!(blocked.autoplay, Some(Autoplay::Deny));
        assert!(SitePolicy::from_rules(&json!({})).is_default());
        let wrapped =
            SitePolicy::from_rules(&json!({ "settings": { "autoplay": { "value": "block" } } }));
        assert!(!wrapped.is_default());
    }

    #[test]
    fn private_choices_stay_in_memory_per_session() {
        let profile = "private-1@";
        set_private_choice(profile, "https://a.com", "popups", "allow");
        set_private_choice(profile, "https://a.com", "camera", "block");
        let settings = private_settings(profile, "https://a.com");
        assert_eq!(settings["popups"]["value"], "allow");
        assert_eq!(settings["camera"]["value"], "block");
        assert_eq!(settings["microphone"]["value"], "ask");
        assert_eq!(settings["sound"]["value"], "allow");
        assert_eq!(settings["clipboard"]["value"], "ask");
        assert_eq!(settings["javascript"]["isDefault"], true);
        end_private_session("private-1");
        assert_eq!(
            private_settings(profile, "https://a.com")["popups"]["value"],
            "block"
        );
    }

    #[test]
    fn cookie_rules_match_the_old_filter() {
        assert_eq!(
            cookie_filter("https://a.b.com:8443").as_deref(),
            Some("^https://a\\.b\\.com:8443[/?#]")
        );
        assert_eq!(cookie_filter("https://"), None);
        assert_eq!(cookie_rule_identifier("ab"), "cookies-6162");
        remember_policy(
            "p",
            "https://x.com",
            &json!({ "images": { "value": "block" } }),
        );
        assert!(!policy("p", "https://x.com").images);
        remember_policy("p", "https://x.com", &json!({}));
        assert!(policy("p", "https://x.com").is_default());
        assert_eq!(
            origins_from(&json!(["https://a.com", { "origin": "https://b.com" }])),
            vec!["https://a.com", "https://b.com"]
        );
    }
}
