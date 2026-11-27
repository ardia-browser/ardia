use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;

pub const GATE_DEADLINE: Duration = Duration::from_millis(600);
pub const CARRY_DEADLINE: Duration = Duration::from_millis(450);

pub type GateHook = Arc<dyn Fn(String, String, String) + Send + Sync>;
pub type Proceed = Box<dyn FnOnce()>;

static WATCHING: AtomicBool = AtomicBool::new(false);
static HOOK: Mutex<Option<GateHook>> = Mutex::new(None);

thread_local! {
    static GATES: RefCell<(u64, HashMap<String, Proceed>)> = RefCell::new((0, HashMap::new()));
}

pub fn set_watching(on: bool) {
    WATCHING.store(on, Ordering::Release);
}

pub fn watching() -> bool {
    WATCHING.load(Ordering::Acquire)
}

pub fn set_hook(hook: Option<GateHook>) {
    *HOOK.lock() = hook;
}

pub fn gated_host(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = gated_host(url)?;
    let scheme = parsed.scheme();
    Some(match parsed.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

pub fn private_profile(profile: &str) -> bool {
    profile.contains('@')
}

pub fn gate_origin(profile: &str, url: &str, current: Option<&str>) -> Option<String> {
    gate_origin_when(watching(), profile, url, current)
}

pub fn gate_origin_when(
    watching: bool,
    profile: &str,
    url: &str,
    current: Option<&str>,
) -> Option<String> {
    if !watching || private_profile(profile) {
        return None;
    }
    let origin = origin_of(url)?;
    let host = gated_host(url);
    (host != current.and_then(gated_host)).then_some(origin)
}

pub fn hold(
    profile: &str,
    url: &str,
    current: Option<&str>,
    proceed: Proceed,
) -> Result<(), Proceed> {
    let Some(origin) = gate_origin(profile, url, current) else {
        return Err(proceed);
    };
    let Some(hook) = HOOK.lock().clone() else {
        return Err(proceed);
    };
    let id = GATES.with(|gates| {
        let mut gates = gates.borrow_mut();
        gates.0 += 1;
        let id = format!("g{}", gates.0);
        gates.1.insert(id.clone(), proceed);
        id
    });
    hook(id, profile.to_owned(), origin);
    Ok(())
}

pub fn release(id: &str) {
    let proceed = GATES.with(|gates| gates.borrow_mut().1.remove(id));
    if let Some(proceed) = proceed {
        proceed();
    }
}

pub fn pending() -> usize {
    GATES.with(|gates| gates.borrow().1.len())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;

    #[test]
    fn only_a_new_web_host_in_a_normal_profile_is_gated() {
        assert_eq!(
            gate_origin_when(true, "", "https://Mail.Example.com/inbox", None).as_deref(),
            Some("https://mail.example.com")
        );
        assert_eq!(
            gate_origin_when(true, "", "http://a.test:8080/x", Some("https://b.test/")).as_deref(),
            Some("http://a.test:8080")
        );
        assert_eq!(
            gate_origin_when(true, "", "https://a.test/next", Some("https://a.test/")),
            None
        );
        assert_eq!(gate_origin_when(true, "x@", "https://a.test/", None), None);
        assert_eq!(gate_origin_when(true, "", "about:blank", None), None);
        assert_eq!(gate_origin_when(false, "", "https://a.test/", None), None);
    }

    #[test]
    fn a_held_load_proceeds_once_when_released() {
        set_watching(true);
        let asked: Arc<Mutex<Vec<(String, String, String)>>> = Arc::default();
        let seen = Arc::clone(&asked);
        set_hook(Some(Arc::new(move |id, profile, origin| {
            seen.lock().push((id, profile, origin))
        })));
        let ran = Rc::new(Cell::new(0));
        let counter = Rc::clone(&ran);
        let held = hold(
            "Profile 1",
            "https://x.test/a",
            None,
            Box::new(move || counter.set(counter.get() + 1)),
        );
        assert!(held.is_ok());
        assert_eq!(ran.get(), 0);
        let (id, profile, origin) = asked.lock()[0].clone();
        assert_eq!(
            (profile.as_str(), origin.as_str()),
            ("Profile 1", "https://x.test")
        );
        release(&id);
        release(&id);
        assert_eq!(ran.get(), 1);
        let free = hold(
            "",
            "https://x.test/b",
            Some("https://x.test/"),
            Box::new(|| {}),
        );
        assert!(free.is_err());
        set_hook(None);
        set_watching(false);
    }
}
