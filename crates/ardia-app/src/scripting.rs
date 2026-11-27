use std::sync::Arc;
use std::time::Duration;

use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, ProfileId, TabId, WindowId};
use ardia_ui::host::UiHost;
use futures::FutureExt;
use futures::future::LocalBoxFuture;
use serde_json::Value;

use crate::coordinator::AppCoordinator;

#[cfg(target_os = "macos")]
pub mod mac;

pub const JAVASCRIPT_OFF: &str = "Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.";
pub const JAVASCRIPT_OFF_NUMBER: isize = 12;
pub const FAILED_NUMBER: isize = -10000;
pub const NOT_READY: &str = "Ardia isn't ready yet.";
pub const TIMED_OUT: &str = "Ardia didn't respond in time.";
pub const NO_TAB: &str = "That tab no longer exists.";
pub const NO_WINDOW: &str = "That window no longer exists.";
pub const NO_PROFILE: &str = "That profile no longer exists.";
pub const NO_INDEX: &str = "There's no tab at that index.";
pub const NO_PROFILE_WINDOW: &str = "There's no window to show the profile in.";
pub const NOT_LOADED: &str = "The tab hasn't loaded yet; focus it first.";
pub const NO_ANSWER: &str = "The page didn't answer.";
pub const MISSING_JAVASCRIPT: &str = "Missing the \u{201c}javascript\u{201d} parameter.";
pub const BAD_TEXT: &str = "That text can't be used.";
pub const TOO_LONG: &str = "That text is too long.";
pub const REPLY_DEADLINE: Duration = Duration::from_secs(20);
pub const MAX_URL_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_CODE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_ERROR_CHARS: usize = 2000;

#[derive(Clone, Debug, PartialEq)]
pub enum ScriptRequest {
    NewWindow {
        url: Option<String>,
        incognito: bool,
        profile: Option<String>,
    },
    NewTab {
        url: Option<String>,
        window: Option<String>,
        index: Option<isize>,
    },
    SetUrl {
        tab: String,
        url: String,
    },
    CloseTab {
        tab: String,
    },
    CloseWindow {
        window: String,
    },
    Reload {
        tab: String,
    },
    Back {
        tab: String,
    },
    Forward {
        tab: String,
    },
    FocusTab {
        tab: String,
    },
    SetActiveTabIndex {
        window: String,
        index: isize,
    },
    FocusProfile {
        profile: String,
    },
    Execute {
        tab: String,
        code: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScriptReply {
    Done,
    Window(WindowId),
    Tab(TabId),
    Text(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScriptError {
    Failed(String),
    JavaScriptOff,
}

impl ScriptError {
    pub fn failed(message: &str) -> Self {
        ScriptError::Failed(message.to_owned())
    }

    pub fn number(&self) -> isize {
        match self {
            ScriptError::Failed(_) => FAILED_NUMBER,
            ScriptError::JavaScriptOff => JAVASCRIPT_OFF_NUMBER,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ScriptError::Failed(message) => message,
            ScriptError::JavaScriptOff => JAVASCRIPT_OFF,
        }
    }
}

pub type ScriptResult = Result<ScriptReply, ScriptError>;

pub fn clean_text(raw: &str, limit: usize) -> Result<String, ScriptError> {
    if raw.len() > limit {
        return Err(ScriptError::failed(TOO_LONG));
    }
    if raw.contains('\0') {
        return Err(ScriptError::failed(BAD_TEXT));
    }
    Ok(raw.to_owned())
}

pub fn clean_id(raw: &str) -> Option<String> {
    (!raw.is_empty()
        && raw.len() <= MAX_ID_BYTES
        && !raw.chars().any(|c| c.is_control() || c.is_whitespace()))
    .then(|| raw.to_owned())
}

pub fn runs_script(state: &BrowserState, url: &str) -> bool {
    let resolved =
        ardia_state::omnibox::url::resolve_input(url, &state.default_search_engine().url);
    crate::links::runs_javascript(url) || crate::links::runs_javascript(&resolved)
}

pub fn refuses_url(state: &BrowserState, url: &str) -> bool {
    !state.settings.allow_javascript_from_apple_events && runs_script(state, url)
}

pub fn script_url_as_chromium_reads_it(url: &str) -> String {
    url.trim_start_matches(|c: char| c.is_whitespace() || c.is_control())
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect()
}

pub const BLANK_PAGE: &str = "about:blank";
pub const BLANK_PAGE_WAIT: Duration = Duration::from_secs(10);
const BLANK_PAGE_TICK: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq, Eq)]
struct PageUrl {
    load: Option<String>,
    script: Option<String>,
}

fn page_url(state: &BrowserState, url: Option<String>) -> Result<PageUrl, ScriptError> {
    let Some(url) = url else {
        return Ok(PageUrl {
            load: None,
            script: None,
        });
    };
    let url = clean_text(&url, MAX_URL_BYTES)?;
    if refuses_url(state, &url) {
        return Err(ScriptError::JavaScriptOff);
    }
    Ok(if runs_script(state, &url) {
        PageUrl {
            load: Some(BLANK_PAGE.to_owned()),
            script: Some(script_url_as_chromium_reads_it(&url)),
        }
    } else {
        PageUrl {
            load: Some(url),
            script: None,
        }
    })
}

fn ticks(every: Duration, count: usize) -> futures::channel::mpsc::UnboundedReceiver<()> {
    let (tick, ticks) = futures::channel::mpsc::unbounded();
    let started = std::thread::Builder::new()
        .name("ardia-script-blank-page".into())
        .spawn(move || {
            for _ in 0..count {
                std::thread::sleep(every);
                if tick.unbounded_send(()).is_err() {
                    return;
                }
            }
        });
    if let Err(problem) = started {
        log::debug!("an AppleScript blank-page wait didn't start: {problem}");
    }
    ticks
}

fn blank_page_ready(coordinator: &AppCoordinator, tab: &TabId) -> Option<bool> {
    let state = coordinator.store().snapshot();
    let listed = state.tab(tab.as_str())?;
    Some(listed.url == BLANK_PAGE && !listed.live.loading && has_page(coordinator, tab))
}

pub fn run_on_blank_page(coordinator: &AppCoordinator, tab: TabId, script_url: String) {
    use futures::StreamExt;
    let me = coordinator.weak();
    let count = (BLANK_PAGE_WAIT.as_millis() / BLANK_PAGE_TICK.as_millis()) as usize;
    let mut ticks = ticks(BLANK_PAGE_TICK, count);
    coordinator.spawn(async move {
        let mut settled = 0;
        while ticks.next().await.is_some() {
            let Some(me) = me.upgrade() else {
                return;
            };
            match blank_page_ready(&me, &tab) {
                None => return,
                Some(true) => settled += 1,
                Some(false) => settled = 0,
            }
            if settled >= 2 {
                me.run_bookmarklet_in(&tab, &script_url);
                return;
            }
        }
        log::debug!("an AppleScript javascript: page never became ready");
    });
}

fn then_run(coordinator: &AppCoordinator, tab: Option<&TabId>, script: Option<String>) {
    if let (Some(tab), Some(script)) = (tab, script) {
        run_on_blank_page(coordinator, tab.clone(), script);
    }
}

pub fn is_scripted(window: &ardia_state::windows::BrowserWindow) -> bool {
    window.kind.has_tabs()
}

pub fn scripted_windows(state: &BrowserState, front_to_back: &[WindowId]) -> Vec<WindowId> {
    let mut ordered: Vec<WindowId> = Vec::new();
    let listed = front_to_back
        .iter()
        .chain(state.focus_order.iter())
        .chain(state.window_order.iter());
    for id in listed {
        if !ordered.contains(id) && state.window(id.as_str()).is_some_and(|w| is_scripted(w)) {
            ordered.push(id.clone());
        }
    }
    ordered
}

pub fn tab_window_named(state: &BrowserState, id: &str) -> Option<WindowId> {
    state
        .window(id)
        .filter(|w| is_scripted(w))
        .map(|w| w.id.clone())
}

pub fn resolve_window(state: &BrowserState, wanted: Option<&str>) -> Option<WindowId> {
    if let Some(window) = wanted.and_then(|id| state.window(id))
        && is_scripted(window)
    {
        return Some(window.id.clone());
    }
    let main = |id: &&WindowId| {
        state
            .window(id.as_str())
            .is_some_and(|w| is_scripted(w) && w.kind != WindowKind::LittleArdia)
    };
    state
        .focus_order
        .iter()
        .find(main)
        .or_else(|| state.window_order.iter().find(main))
        .cloned()
}

fn plural(n: usize, word: &str) -> String {
    if n == 1 {
        format!("1 {word}")
    } else {
        format!("{n} {word}s")
    }
}

pub fn profile_name(state: &BrowserState, window: &ardia_state::windows::BrowserWindow) -> String {
    if window.kind == WindowKind::Incognito || window.profile_id.is_incognito() {
        return "Incognito".to_owned();
    }
    state
        .profile(window.profile_id.as_str())
        .or_else(|| state.profile(state.settings.default_profile_id.as_str()))
        .map_or_else(|| "Incognito".to_owned(), |p| p.name.clone())
}

pub fn window_name(state: &BrowserState, id: &str) -> String {
    let Some(window) = state.window(id) else {
        return String::new();
    };
    let label = state
        .active_tab(id)
        .map_or_else(|| "New Tab".to_owned(), |t| t.label());
    let others = state.view_tabs(id, None).len().saturating_sub(1);
    let name = profile_name(state, window);
    if others > 0 {
        format!("{name} \u{2014} {label} & {}", plural(others, "Tab"))
    } else {
        format!("{name} \u{2014} {label}")
    }
}

pub fn window_tabs(state: &BrowserState, id: &str) -> Vec<TabId> {
    state
        .view_tabs(id, None)
        .into_iter()
        .map(|t| t.id.clone())
        .collect()
}

pub fn active_tab(state: &BrowserState, id: &str) -> Option<TabId> {
    state.active_tab(id).map(|t| t.id.clone())
}

pub fn tab_window(state: &BrowserState, tab: &str) -> Option<WindowId> {
    let tab = state.tab(tab)?;
    let window = state.window(tab.window_id.as_str())?;
    (is_scripted(window) && window_tabs(state, window.id.as_str()).contains(&tab.id))
        .then(|| window.id.clone())
}

pub fn tab_title(state: &BrowserState, tab: &str) -> String {
    state.tab(tab).map_or_else(String::new, |t| {
        t.custom_title
            .clone()
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| t.title.clone())
    })
}

pub fn profile_tabs(state: &BrowserState, profile: &str, windows: &[WindowId]) -> Vec<TabId> {
    windows
        .iter()
        .filter(|w| {
            state
                .window(w.as_str())
                .is_some_and(|w| w.profile_id.as_str() == profile)
        })
        .flat_map(|w| window_tabs(state, w.as_str()))
        .collect()
}

pub fn execute_body(code: &str) -> String {
    let literal = serde_json::to_string(code)
        .unwrap_or_else(|_| "\"\"".to_owned())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"const text = (v) => {{
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {{ const json = JSON.stringify(v); return json === undefined ? String(v) : json; }} catch {{ return String(v); }}
}};
let value;
try {{ value = (0, eval)({literal}); }} catch (e) {{ post("result", JSON.stringify({{ error: String(e) }})); return; }}
Promise.resolve(value).then(
  (v) => post("result", JSON.stringify({{ value: text(v) }})),
  (e) => post("result", JSON.stringify({{ error: String(e) }})),
);"#
    )
}

pub fn execute_outcome(answer: Option<Value>) -> ScriptResult {
    let answer = match answer {
        Some(Value::String(text)) => serde_json::from_str(&text).ok(),
        other => other,
    };
    let Some(Value::Object(fields)) = answer else {
        return Err(ScriptError::failed(NO_ANSWER));
    };
    if let Some(error) = fields.get("error") {
        let text = error
            .as_str()
            .map_or_else(|| error.to_string(), str::to_owned);
        let shown: String = text
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .take(MAX_ERROR_CHARS)
            .collect();
        return Err(ScriptError::Failed(if shown.trim().is_empty() {
            NO_ANSWER.to_owned()
        } else {
            shown
        }));
    }
    match fields.get("value") {
        Some(Value::String(value)) => Ok(ScriptReply::Text(value.clone())),
        Some(Value::Null) | None => Ok(ScriptReply::Text(String::new())),
        Some(other) => Ok(ScriptReply::Text(other.to_string())),
    }
}

fn existing_tab(state: &BrowserState, tab: &str) -> Result<(TabId, WindowId), ScriptError> {
    let window = tab_window(state, tab).ok_or_else(|| ScriptError::failed(NO_TAB))?;
    Ok((TabId::new(tab), window))
}

fn existing_window(state: &BrowserState, window: &str) -> Result<WindowId, ScriptError> {
    state
        .window(window)
        .filter(|w| is_scripted(w))
        .map(|w| w.id.clone())
        .ok_or_else(|| ScriptError::failed(NO_WINDOW))
}

pub fn new_tab_index(
    state: &BrowserState,
    window: &WindowId,
    wanted: Option<isize>,
) -> Option<usize> {
    let wanted = usize::try_from(wanted?).ok()?;
    let w = state.window(window.as_str())?;
    let view = window_tabs(state, window.as_str());
    let pinned = view
        .iter()
        .filter(|id| state.tab(id.as_str()).is_some_and(|t| t.pin.is_some()))
        .count();
    let at = wanted.max(pinned);
    Some(match view.get(at) {
        Some(tab) => w
            .tab_ids
            .iter()
            .position(|id| id == tab)
            .unwrap_or(w.tab_ids.len()),
        None => w.tab_ids.len(),
    })
}

fn has_page(coordinator: &AppCoordinator, tab: &TabId) -> bool {
    coordinator.engine_tab(tab).is_some() || webkit_page(tab)
}

#[cfg(target_os = "macos")]
fn webkit_page(tab: &TabId) -> bool {
    crate::webkit::page::has(tab)
}

#[cfg(not(target_os = "macos"))]
fn webkit_page(_tab: &TabId) -> bool {
    false
}

fn ready(result: ScriptResult) -> LocalBoxFuture<'static, ScriptResult> {
    futures::future::ready(result).boxed_local()
}

pub fn run(
    coordinator: &Arc<AppCoordinator>,
    request: ScriptRequest,
) -> LocalBoxFuture<'static, ScriptResult> {
    match request {
        ScriptRequest::Execute { tab, code } => execute(coordinator, &tab, &code),
        other => ready(perform(coordinator, other)),
    }
}

fn perform(coordinator: &AppCoordinator, request: ScriptRequest) -> ScriptResult {
    let state = coordinator.store().snapshot();
    match request {
        ScriptRequest::NewWindow {
            url,
            incognito,
            profile,
        } => {
            let PageUrl { load: url, script } = page_url(&state, url)?;
            let profile = match profile {
                Some(id) if !incognito => {
                    if state.profile(&id).is_none() {
                        return Err(ScriptError::failed(NO_PROFILE));
                    }
                    Some(ProfileId::new(id))
                }
                _ => None,
            };
            let outcome = coordinator
                .dispatch_action(Action::OpenWindow {
                    kind: if incognito {
                        WindowKind::Incognito
                    } else {
                        WindowKind::Main
                    },
                    profile,
                    url,
                    frame: None,
                })
                .map_err(|problem| ScriptError::Failed(problem.to_string()))?;
            coordinator.mark_dirty();
            let window = outcome
                .window
                .ok_or_else(|| ScriptError::failed(NO_WINDOW))?;
            let opened = active_tab(&coordinator.store().snapshot(), window.as_str());
            then_run(coordinator, opened.as_ref(), script);
            Ok(ScriptReply::Window(window))
        }
        ScriptRequest::NewTab { url, window, index } => {
            let PageUrl { load: url, script } = page_url(&state, url)?;
            if let Some(named) = window.as_deref()
                && tab_window_named(&state, named).is_none()
            {
                return Err(ScriptError::failed(NO_WINDOW));
            }
            let Some(window) = resolve_window(&state, window.as_deref()) else {
                let outcome = coordinator
                    .dispatch_action(Action::OpenWindow {
                        kind: WindowKind::Main,
                        profile: None,
                        url,
                        frame: None,
                    })
                    .map_err(|problem| ScriptError::Failed(problem.to_string()))?;
                coordinator.mark_dirty();
                let window = outcome
                    .window
                    .ok_or_else(|| ScriptError::failed(NO_WINDOW))?;
                let after = coordinator.store().snapshot();
                let opened = active_tab(&after, window.as_str());
                then_run(coordinator, opened.as_ref(), script);
                return Ok(opened.map_or(ScriptReply::Window(window), ScriptReply::Tab));
            };
            let index = new_tab_index(&state, &window, index);
            let outcome = coordinator
                .dispatch_action(Action::NewTab {
                    window,
                    tab: ardia_state::NewTab {
                        url,
                        index,
                        ..ardia_state::NewTab::default()
                    },
                })
                .map_err(|problem| ScriptError::Failed(problem.to_string()))?;
            coordinator.mark_dirty();
            let tab = outcome.tab.ok_or_else(|| ScriptError::failed(NO_TAB))?;
            then_run(coordinator, Some(&tab), script);
            Ok(ScriptReply::Tab(tab))
        }
        ScriptRequest::SetUrl { tab, url } => {
            let (tab, window) = existing_tab(&state, &tab)?;
            let url = clean_text(&url, MAX_URL_BYTES)?;
            if refuses_url(&state, &url) {
                return Err(ScriptError::JavaScriptOff);
            }
            if runs_script(&state, &url) {
                coordinator.run_bookmarklet_in(&tab, &script_url_as_chromium_reads_it(&url));
            } else {
                UiHost::navigate(coordinator, window, tab, url);
            }
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::CloseTab { tab } => {
            let (tab, _) = existing_tab(&state, &tab)?;
            coordinator.dispatch_quietly(Action::CloseTabs {
                tabs: vec![tab],
                last_closes_window: false,
            });
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::CloseWindow { window } => {
            let window = existing_window(&state, &window)?;
            coordinator.dispatch_quietly(Action::CloseWindow { window });
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::Reload { tab } => {
            let (tab, window) = existing_tab(&state, &tab)?;
            if has_page(coordinator, &tab) {
                UiHost::reload(coordinator, tab, false);
            } else if let Some(url) = state
                .tab(tab.as_str())
                .map(|t| t.url.clone())
                .filter(|u| !u.is_empty())
            {
                UiHost::navigate(coordinator, window, tab, url);
            }
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::Back { tab } => {
            let (tab, _) = existing_tab(&state, &tab)?;
            if !has_page(coordinator, &tab) {
                return Err(ScriptError::failed(NOT_LOADED));
            }
            UiHost::go_back(coordinator, tab);
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::Forward { tab } => {
            let (tab, _) = existing_tab(&state, &tab)?;
            if !has_page(coordinator, &tab) {
                return Err(ScriptError::failed(NOT_LOADED));
            }
            UiHost::go_forward(coordinator, tab);
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::FocusTab { tab } => {
            let (tab, window) = existing_tab(&state, &tab)?;
            focus_tab(coordinator, &state, tab, window);
            Ok(ScriptReply::Done)
        }
        ScriptRequest::SetActiveTabIndex { window, index } => {
            let window = existing_window(&state, &window)?;
            let tabs = window_tabs(&state, window.as_str());
            let tab = usize::try_from(index)
                .ok()
                .and_then(|i| i.checked_sub(1))
                .and_then(|i| tabs.get(i))
                .cloned()
                .ok_or_else(|| ScriptError::failed(NO_INDEX))?;
            coordinator.dispatch_quietly(Action::ActivateTab { tab });
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::FocusProfile { profile } => {
            let window = resolve_window(&state, None);
            if state.profile(&profile).is_none() {
                return Err(ScriptError::failed(NO_PROFILE));
            }
            let window = window
                .filter(|w| {
                    state
                        .window(w.as_str())
                        .is_some_and(|w| w.kind != WindowKind::Incognito)
                })
                .ok_or_else(|| ScriptError::failed(NO_PROFILE_WINDOW))?;
            coordinator.dispatch_quietly(Action::SwitchProfile {
                window,
                profile: ProfileId::new(profile),
            });
            coordinator.mark_dirty();
            Ok(ScriptReply::Done)
        }
        ScriptRequest::Execute { .. } => Err(ScriptError::failed(NO_ANSWER)),
    }
}

fn focus_tab(coordinator: &AppCoordinator, state: &BrowserState, tab: TabId, window: WindowId) {
    coordinator.dispatch_quietly(Action::ActivateTab { tab });
    if state.focus_order.first() != Some(&window) {
        coordinator.dispatch_quietly(Action::FocusWindow {
            window: window.clone(),
        });
        coordinator.effect(crate::coordinator::ShellEffect::FocusWindow { window });
    }
    coordinator.mark_dirty();
}

fn execute(
    coordinator: &Arc<AppCoordinator>,
    tab: &str,
    code: &str,
) -> LocalBoxFuture<'static, ScriptResult> {
    let state = coordinator.store().snapshot();
    let tab = match existing_tab(&state, tab) {
        Ok((tab, _)) => tab,
        Err(problem) => return ready(Err(problem)),
    };
    if !state.settings.allow_javascript_from_apple_events {
        return ready(Err(ScriptError::JavaScriptOff));
    }
    let code = match clean_text(code, MAX_CODE_BYTES) {
        Ok(code) => code,
        Err(problem) => return ready(Err(problem)),
    };
    let body = execute_body(&code);
    if let (Some(engine_tab), Some(engine)) = (coordinator.engine_tab(&tab), coordinator.engine()) {
        let reply = engine.evaluate_js(engine_tab, &body);
        return async move {
            match reply.await {
                Ok(answer) => execute_outcome(answer),
                Err(problem) => Err(ScriptError::Failed(problem.to_string())),
            }
        }
        .boxed_local();
    }
    execute_in_webkit(&tab, &body)
}

#[cfg(target_os = "macos")]
fn execute_in_webkit(tab: &TabId, body: &str) -> LocalBoxFuture<'static, ScriptResult> {
    if !crate::webkit::page::has(tab) {
        return ready(Err(ScriptError::failed(NOT_LOADED)));
    }
    let (answer, reply) = futures::channel::oneshot::channel();
    crate::webkit::page::evaluate(
        tab,
        body,
        Box::new(move |result| {
            let _ = answer.send(result);
        }),
    );
    async move {
        let text = reply.await.ok().flatten();
        execute_outcome(text.map(Value::String))
    }
    .boxed_local()
}

#[cfg(not(target_os = "macos"))]
fn execute_in_webkit(_tab: &TabId, _body: &str) -> LocalBoxFuture<'static, ScriptResult> {
    ready(Err(ScriptError::failed(NOT_LOADED)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_engine::{BrowserEngine, MockBrowserEngine};
    use ardia_state::BrowserStore;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use futures::executor::block_on;

    const HOSTILE: &[&str] = &[
        "",
        "\r",
        "\n",
        "\r\n",
        "\u{c}",
        "\u{b}",
        "\u{85}",
        "\u{2028}",
        "\u{2029}",
        "\0",
        "a\0b",
        "\u{feff}",
        "__proto__",
        "constructor",
        "prototype",
        "../../etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "ardia://settings",
        "chrome://settings",
        "\"; alert(1); //",
        "</script><script>alert(1)</script>",
        "${alert(1)}",
        "`${1}`",
        "\\",
        "\u{10ffff}",
        "\u{fffd}",
    ];

    const SCRIPT_URLS: &[&str] = &[
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "  javascript:alert(1)",
        "\u{1}\u{2}javascript:alert(1)",
        "\0javascript:alert(1)",
        "\tjavascript:alert(1)",
        "java\tscript:alert(1)",
        "java\nscript:alert(1)",
        "java\rscript:alert(1)",
        "j\na\tv\ra\nscript:alert(1)",
        "\u{1f}javascript:void(0)",
        " \n javascript:void(0)",
    ];

    fn app() -> (Arc<AppCoordinator>, Arc<MockBrowserEngine>, WindowId) {
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("script"),
        ));
        let mock = Arc::new(MockBrowserEngine::started());
        let engine: Arc<dyn BrowserEngine> = mock.clone();
        let app = AppCoordinator::new(
            store,
            engine,
            crate::coordinator::CoordinatorConfig::default(),
        );
        app.start();
        app.pump();
        let window = app
            .dispatch_action(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example/".into()),
                frame: None,
            })
            .unwrap()
            .window
            .unwrap();
        app.pump();
        (app, mock, window)
    }

    fn allow_javascript(app: &AppCoordinator, on: bool) {
        app.dispatch_action(Action::UpdateSettings {
            patch: ardia_state::settings::SettingsPatch::new()
                .set("allowJavaScriptFromAppleEvents", on),
            from_sync: false,
        })
        .unwrap();
    }

    fn ask(app: &Arc<AppCoordinator>, request: ScriptRequest) -> ScriptResult {
        let result = block_on(run(app, request));
        app.pump();
        result
    }

    fn first_tab(app: &AppCoordinator, window: &WindowId) -> TabId {
        window_tabs(&app.store().snapshot(), window.as_str())[0].clone()
    }

    #[test]
    fn script_urls_are_spotted_however_chromium_would_read_them() {
        let state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1);
        for url in SCRIPT_URLS {
            assert!(refuses_url(&state, url), "{url:?} runs script");
        }
        for url in [
            "https://javascript.info",
            "java",
            "javascript",
            "https://a.example/?q=javascript:alert(1)",
            "\u{feff}https://a.example",
        ] {
            assert!(!refuses_url(&state, url), "{url:?} is not a script");
        }
    }

    #[test]
    fn the_old_apps_error_numbers_and_messages_come_back() {
        assert_eq!(ScriptError::JavaScriptOff.number(), 12);
        assert_eq!(
            ScriptError::JavaScriptOff.message(),
            "Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events."
        );
        assert_eq!(ScriptError::failed(NO_TAB).number(), -10000);
    }

    #[test]
    fn windows_tabs_and_titles_read_from_the_store() {
        let (app, _, window) = app();
        let state = app.store().snapshot();
        let windows = scripted_windows(&state, std::slice::from_ref(&window));
        assert_eq!(windows.first(), Some(&window));
        assert_eq!(windows.len(), state.window_order.len());
        let tabs = window_tabs(&state, window.as_str());
        assert_eq!(tabs.len(), 1);
        assert_eq!(active_tab(&state, window.as_str()), Some(tabs[0].clone()));
        assert_eq!(tab_window(&state, tabs[0].as_str()), Some(window.clone()));
        assert!(window_name(&state, window.as_str()).contains(" \u{2014} "));
        let profile = state.window(window.as_str()).unwrap().profile_id.clone();
        assert!(
            profile_tabs(&state, profile.as_str(), &windows)
                .iter()
                .take(tabs.len())
                .eq(tabs.iter())
        );
    }

    #[test]
    fn make_set_and_close_go_through_the_store() {
        let (app, _, window) = app();
        let made = ask(
            &app,
            ScriptRequest::NewTab {
                url: Some("https://b.example/".into()),
                window: Some(window.to_string()),
                index: None,
            },
        )
        .unwrap();
        let ScriptReply::Tab(tab) = made else {
            panic!("a new tab answers with its tab");
        };
        let state = app.store().snapshot();
        assert_eq!(window_tabs(&state, window.as_str()).len(), 2);
        assert_eq!(state.tab(tab.as_str()).unwrap().url, "https://b.example/");
        assert_eq!(
            ask(
                &app,
                ScriptRequest::SetUrl {
                    tab: tab.to_string(),
                    url: "https://c.example/".into()
                }
            ),
            Ok(ScriptReply::Done)
        );
        assert_eq!(
            app.store().snapshot().tab(tab.as_str()).unwrap().url,
            "https://c.example/"
        );
        assert_eq!(
            ask(
                &app,
                ScriptRequest::CloseTab {
                    tab: tab.to_string()
                }
            ),
            Ok(ScriptReply::Done)
        );
        assert!(app.store().snapshot().tab(tab.as_str()).is_none());
        assert_eq!(
            ask(
                &app,
                ScriptRequest::CloseTab {
                    tab: tab.to_string()
                }
            ),
            Err(ScriptError::failed(NO_TAB))
        );
    }

    #[test]
    fn a_new_tab_index_never_lands_among_pinned_tabs() {
        let (app, _, window) = app();
        let state = app.store().snapshot();
        assert_eq!(new_tab_index(&state, &window, None), None);
        assert_eq!(new_tab_index(&state, &window, Some(-1)), None);
        assert_eq!(new_tab_index(&state, &window, Some(0)), Some(0));
        assert_eq!(new_tab_index(&state, &window, Some(isize::MAX)), Some(1));
    }

    #[test]
    fn script_urls_are_refused_while_the_setting_is_off() {
        let (app, _, window) = app();
        let tab = first_tab(&app, &window);
        let windows_before = scripted_windows(&app.store().snapshot(), &[]).len();
        for url in SCRIPT_URLS {
            let refusal = if url.contains('\0') {
                ScriptError::failed(BAD_TEXT)
            } else {
                ScriptError::JavaScriptOff
            };
            for request in [
                ScriptRequest::SetUrl {
                    tab: tab.to_string(),
                    url: (*url).to_owned(),
                },
                ScriptRequest::NewTab {
                    url: Some((*url).to_owned()),
                    window: None,
                    index: None,
                },
                ScriptRequest::NewWindow {
                    url: Some((*url).to_owned()),
                    incognito: false,
                    profile: None,
                },
            ] {
                assert_eq!(ask(&app, request), Err(refusal.clone()), "{url:?}");
            }
        }
        let state = app.store().snapshot();
        assert_eq!(state.tab(tab.as_str()).unwrap().url, "https://a.example/");
        assert_eq!(scripted_windows(&state, &[]).len(), windows_before);
        assert_eq!(window_tabs(&state, window.as_str()).len(), 1);
        allow_javascript(&app, true);
        assert_eq!(
            ask(
                &app,
                ScriptRequest::SetUrl {
                    tab: tab.to_string(),
                    url: "java\tscript:void(0)".into()
                }
            ),
            Ok(ScriptReply::Done)
        );
        assert_eq!(
            app.store().snapshot().tab(tab.as_str()).unwrap().url,
            "https://a.example/",
            "a script URL runs in the page instead of becoming a search"
        );
        assert_eq!(
            script_url_as_chromium_reads_it(" \u{1}java\tscr\nipt:x"),
            "javascript:x"
        );
    }

    #[test]
    fn execute_is_refused_while_off_and_runs_the_wrapped_code_when_on() {
        let (app, mock, window) = app();
        let tab = first_tab(&app, &window);
        mock.set_evaluator(|_, code| {
            assert!(code.contains("(0, eval)("));
            Ok(Some(Value::String("{\"value\":\"2\"}".into())))
        });
        let execute = ScriptRequest::Execute {
            tab: tab.to_string(),
            code: "1+1".into(),
        };
        assert_eq!(ask(&app, execute.clone()), Err(ScriptError::JavaScriptOff));
        allow_javascript(&app, true);
        assert_eq!(ask(&app, execute), Ok(ScriptReply::Text("2".into())));
        assert_eq!(
            ask(
                &app,
                ScriptRequest::Execute {
                    tab: "missing".into(),
                    code: "1".into()
                }
            ),
            Err(ScriptError::failed(NO_TAB))
        );
        assert_eq!(
            ask(
                &app,
                ScriptRequest::Execute {
                    tab: tab.to_string(),
                    code: "a\0b".into()
                }
            ),
            Err(ScriptError::failed(BAD_TEXT))
        );
    }

    #[test]
    fn hostile_code_stays_one_string_literal_in_the_wrapper() {
        for code in HOSTILE {
            let body = execute_body(code);
            let start = body.find("(0, eval)(").unwrap() + "(0, eval)(".len();
            let end = body[start..].find("); } catch (e)").unwrap() + start;
            let literal = &body[start..end];
            assert!(!literal.contains('\u{2028}') && !literal.contains('\u{2029}'));
            let back: String = serde_json::from_str(literal).unwrap();
            assert_eq!(&back, code, "{code:?} round-trips");
        }
    }

    #[test]
    fn page_answers_are_read_as_data() {
        assert_eq!(
            execute_outcome(Some(serde_json::json!({ "value": "x" }))),
            Ok(ScriptReply::Text("x".into()))
        );
        assert_eq!(
            execute_outcome(Some(serde_json::json!({ "value": 3 }))),
            Ok(ScriptReply::Text("3".into()))
        );
        assert_eq!(execute_outcome(None), Err(ScriptError::failed(NO_ANSWER)));
        assert_eq!(
            execute_outcome(Some(Value::String("not json".into()))),
            Err(ScriptError::failed(NO_ANSWER))
        );
        assert_eq!(
            execute_outcome(Some(serde_json::json!([1, 2]))),
            Err(ScriptError::failed(NO_ANSWER))
        );
        assert_eq!(
            execute_outcome(Some(
                serde_json::json!({ "error": "ReferenceError: x\r\nis not defined" })
            )),
            Err(ScriptError::failed("ReferenceError: x  is not defined"))
        );
        let long = "e".repeat(MAX_ERROR_CHARS * 2);
        let Err(ScriptError::Failed(shown)) =
            execute_outcome(Some(serde_json::json!({ "error": long })))
        else {
            panic!("an error stays an error");
        };
        assert_eq!(shown.chars().count(), MAX_ERROR_CHARS);
    }

    #[test]
    fn hostile_ids_and_indexes_change_nothing() {
        let (app, _, window) = app();
        allow_javascript(&app, true);
        let before = app.store().snapshot().session_json();
        for id in HOSTILE {
            let id = (*id).to_owned();
            for request in [
                ScriptRequest::SetUrl {
                    tab: id.clone(),
                    url: "https://x.example".into(),
                },
                ScriptRequest::CloseTab { tab: id.clone() },
                ScriptRequest::CloseWindow { window: id.clone() },
                ScriptRequest::Reload { tab: id.clone() },
                ScriptRequest::Back { tab: id.clone() },
                ScriptRequest::Forward { tab: id.clone() },
                ScriptRequest::FocusTab { tab: id.clone() },
                ScriptRequest::FocusProfile {
                    profile: id.clone(),
                },
                ScriptRequest::SetActiveTabIndex {
                    window: id.clone(),
                    index: 1,
                },
                ScriptRequest::Execute {
                    tab: id.clone(),
                    code: "1".into(),
                },
                ScriptRequest::NewWindow {
                    url: None,
                    incognito: false,
                    profile: Some(id),
                },
            ] {
                assert!(
                    ask(&app, request.clone()).is_err(),
                    "{request:?} is refused"
                );
            }
        }
        for index in [0, -1, 2, isize::MIN, isize::MAX] {
            assert_eq!(
                ask(
                    &app,
                    ScriptRequest::SetActiveTabIndex {
                        window: window.to_string(),
                        index
                    }
                ),
                Err(ScriptError::failed(NO_INDEX))
            );
        }
        assert_eq!(app.store().snapshot().session_json(), before);
    }

    #[test]
    fn hostile_urls_never_reach_a_tab_as_script_or_with_a_nul() {
        let (app, _, window) = app();
        let tab = first_tab(&app, &window);
        for url in HOSTILE {
            let result = ask(
                &app,
                ScriptRequest::SetUrl {
                    tab: tab.to_string(),
                    url: (*url).to_owned(),
                },
            );
            let now = app
                .store()
                .snapshot()
                .tab(tab.as_str())
                .unwrap()
                .url
                .clone();
            assert!(!now.contains('\0'), "{url:?} left a NUL in the tab");
            assert!(
                !crate::links::runs_javascript(&now),
                "{url:?} became a script URL"
            );
            if url.contains('\0') {
                assert_eq!(result, Err(ScriptError::failed(BAD_TEXT)));
            }
        }
        let long = format!("https://a.example/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(
            ask(
                &app,
                ScriptRequest::SetUrl {
                    tab: tab.to_string(),
                    url: long
                }
            ),
            Err(ScriptError::failed(TOO_LONG))
        );
    }

    fn evaluated_scripts(mock: &MockBrowserEngine) -> Vec<String> {
        mock.calls()
            .into_iter()
            .filter_map(|call| match call {
                ardia_engine::mock::MockCall::Evaluate(_, code) => Some(code),
                _ => None,
            })
            .collect()
    }

    fn pump_until(app: &AppCoordinator, within: Duration, mut done: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + within;
        while std::time::Instant::now() < deadline {
            app.pump();
            app.poll_parked();
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_new_tab_or_window_runs_a_script_url_on_a_blank_page_when_allowed() {
        let (app, mock, window) = app();
        allow_javascript(&app, true);
        let Ok(ScriptReply::Tab(tab)) = ask(
            &app,
            ScriptRequest::NewTab {
                url: Some("java\tscript:document.title='w36tab'".into()),
                window: Some(window.to_string()),
                index: None,
            },
        ) else {
            panic!("a new tab answers with its tab");
        };
        assert_eq!(
            app.store().snapshot().tab(tab.as_str()).unwrap().url,
            BLANK_PAGE
        );
        assert!(
            pump_until(&app, BLANK_PAGE_WAIT, || evaluated_scripts(&mock)
                .iter()
                .any(|code| code.contains("document.title='w36tab'"))),
            "the script ran on the blank tab"
        );
        let Ok(ScriptReply::Window(made)) = ask(
            &app,
            ScriptRequest::NewWindow {
                url: Some("javascript:document.title='w36win'".into()),
                incognito: false,
                profile: None,
            },
        ) else {
            panic!("a new window answers with its window");
        };
        let state = app.store().snapshot();
        assert_eq!(state.active_tab(made.as_str()).unwrap().url, BLANK_PAGE);
        assert!(
            pump_until(&app, BLANK_PAGE_WAIT, || evaluated_scripts(&mock)
                .iter()
                .any(|code| code.contains("document.title='w36win'"))),
            "the script ran on the new window's blank tab"
        );
    }

    #[test]
    fn a_script_url_for_a_new_tab_still_runs_nothing_while_off() {
        let (app, mock, window) = app();
        let before = app.store().snapshot().session_json();
        assert_eq!(
            ask(
                &app,
                ScriptRequest::NewTab {
                    url: Some("javascript:document.title='nope'".into()),
                    window: Some(window.to_string()),
                    index: None,
                }
            ),
            Err(ScriptError::JavaScriptOff)
        );
        pump_until(&app, Duration::from_secs(1), || false);
        assert!(
            evaluated_scripts(&mock)
                .iter()
                .all(|code| !code.contains("nope"))
        );
        assert_eq!(app.store().snapshot().session_json(), before);
    }

    #[test]
    fn a_tab_for_a_closed_private_window_never_lands_in_a_profile_window() {
        let (app, _, window) = app();
        let private = app
            .dispatch_action(Action::OpenWindow {
                kind: WindowKind::Incognito,
                profile: None,
                url: None,
                frame: None,
            })
            .unwrap()
            .window
            .unwrap();
        app.pump();
        app.dispatch_action(Action::CloseWindow {
            window: private.clone(),
        })
        .unwrap();
        app.pump();
        let state = app.store().snapshot();
        assert!(state.window(private.as_str()).is_none());
        let fallback = resolve_window(&state, None).unwrap();
        assert!(
            !state
                .window(fallback.as_str())
                .unwrap()
                .profile_id
                .is_incognito(),
            "the old fallback would pick a profile window that keeps history and syncs"
        );
        let tabs_before = window_tabs(&state, window.as_str()).len();
        let before = state.session_json();
        for named in [private.to_string(), String::new(), "w-missing".into()] {
            assert_eq!(
                ask(
                    &app,
                    ScriptRequest::NewTab {
                        url: Some("https://private.example/".into()),
                        window: Some(named),
                        index: Some(0),
                    }
                ),
                Err(ScriptError::failed(NO_WINDOW))
            );
        }
        let after = app.store().snapshot();
        assert_eq!(window_tabs(&after, window.as_str()).len(), tabs_before);
        assert_eq!(after.session_json(), before);
        assert!(matches!(
            ask(
                &app,
                ScriptRequest::NewTab {
                    url: Some("https://front.example/".into()),
                    window: None,
                    index: None,
                }
            ),
            Ok(ScriptReply::Tab(_))
        ));
    }

    #[test]
    fn clean_ids_refuse_blank_control_and_overlong_text() {
        assert_eq!(clean_id("t-1"), Some("t-1".into()));
        for bad in ["", " ", "a b", "a\nb", "a\0b", "\u{85}"] {
            assert_eq!(clean_id(bad), None, "{bad:?}");
        }
        assert_eq!(clean_id(&"a".repeat(MAX_ID_BYTES + 1)), None);
    }
}
