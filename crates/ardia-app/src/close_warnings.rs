use std::cell::Cell;
use std::path::{Path, PathBuf};

use ardia_state::actions::Action;
use ardia_state::group_names::{Member, group_label};
use ardia_state::groups;
use ardia_state::settings::SettingsPatch;
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, ProfileId, TabId, WindowId};
use futures::channel::oneshot;
use serde_json::json;

use crate::coordinator::AppCoordinator;

pub const MIN_WINDOW_TABS: usize = 2;
pub const QUIT_TITLE: &str = "Are you sure you want to quit Ardia?";
pub const QUIT_MESSAGE: &str = "Your windows and tabs will be restored the next time you open it.";
pub const ASK_AGAIN: &str = "Don\u{2019}t ask me again";
pub const QUIT_ASK_AGAIN: &str = "Don't ask again";
pub const MOVE_ASK_AGAIN: &str = "Don't warn me again";
pub const CANCEL: &str = "Cancel";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WarningKind {
    Quitting,
    ClosingWindow,
    ClosingLastTab,
    ClosingTabGroup,
    MovingTabsToProfile,
}

impl WarningKind {
    pub fn setting(self) -> &'static str {
        match self {
            WarningKind::Quitting => "warnBeforeQuitting",
            WarningKind::ClosingWindow => "warnBeforeClosingWindow",
            WarningKind::ClosingLastTab => "warnBeforeClosingLastTab",
            WarningKind::ClosingTabGroup => "warnBeforeClosingTabGroup",
            WarningKind::MovingTabsToProfile => "warnBeforeMovingTabsToProfile",
        }
    }

    pub fn silenced(self) -> SettingsPatch {
        SettingsPatch::new().set(self.setting(), false)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Warning {
    pub kind: WarningKind,
    pub window: Option<WindowId>,
    pub title: String,
    pub message: String,
    pub confirm: String,
    pub suppression: &'static str,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WarningAnswer {
    pub confirmed: bool,
    pub suppressed: bool,
}

thread_local! {
    static CONFIRMED: Cell<bool> = const { Cell::new(false) };
    static ASKING: Cell<bool> = const { Cell::new(false) };
}

pub fn without_warnings<R>(run: impl FnOnce() -> R) -> R {
    let before = CONFIRMED.with(|c| c.replace(true));
    let out = run();
    CONFIRMED.with(|c| c.set(before));
    out
}

pub fn warnings_paused() -> bool {
    CONFIRMED.with(Cell::get)
}

pub fn may_warn(action: &Action) -> bool {
    matches!(
        action,
        Action::CloseWindow { .. }
            | Action::CloseTabs { .. }
            | Action::CloseGroup { .. }
            | Action::MoveTabsToProfile { .. }
    )
}

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

fn is_empty_card(state: &BrowserState, tab: &TabId) -> bool {
    state.tab(tab.as_str()).is_some_and(|t| {
        t.pin.is_none()
            && t.url.is_empty()
            && t.live.navigation.is_none()
            && state.split_of(tab.as_str()).is_none()
    })
}

fn kept_open(state: &BrowserState, tab: &TabId) -> bool {
    state.tab(tab.as_str()).is_some()
        && !state.in_pinned_container(tab.as_str())
        && !is_empty_card(state, tab)
}

fn unpinned_open_tabs(state: &BrowserState, window: &WindowId) -> Vec<TabId> {
    state
        .window(window.as_str())
        .map(|w| {
            w.tab_ids
                .iter()
                .filter(|t| kept_open(state, t))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn profile_name(state: &BrowserState, profile: &ProfileId) -> String {
    state
        .profile(profile.as_str())
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "Default".to_owned())
}

pub fn close_window_warning(state: &BrowserState, window: &WindowId, closing: &[TabId]) -> Warning {
    let fallback = state
        .window(window.as_str())
        .map(|w| w.profile_id.clone())
        .unwrap_or_else(ProfileId::default_profile);
    let mut by_profile: Vec<(ProfileId, usize)> = Vec::new();
    for tab in closing {
        let profile = state
            .tab(tab.as_str())
            .map_or_else(|| fallback.clone(), |t| t.profile_id.clone());
        match by_profile.iter_mut().find(|(p, _)| *p == profile) {
            Some((_, n)) => *n += 1,
            None => by_profile.push((profile, 1)),
        }
    }
    let count = closing.len();
    let message = if by_profile.len() > 1 {
        std::iter::once("Closing this window closes all tabs open across profiles:".to_owned())
            .chain(by_profile.iter().map(|(profile, n)| {
                format!(
                    "  \u{2022} {} in {}",
                    plural(*n, "tab"),
                    profile_name(state, profile)
                )
            }))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        let profile = by_profile.first().map_or(&fallback, |(p, _)| p);
        format!(
            "This window has {} open in your {} profile.",
            plural(count, "tab"),
            profile_name(state, profile)
        )
    };
    Warning {
        kind: WarningKind::ClosingWindow,
        window: Some(window.clone()),
        title: if count == 1 {
            "Close 1 tab?".to_owned()
        } else {
            format!("Close {count} tabs?")
        },
        message,
        confirm: if count == 1 {
            "Close Tab".to_owned()
        } else {
            "Close All Tabs".to_owned()
        },
        suppression: ASK_AGAIN,
    }
}

fn last_regular_window(state: &BrowserState, window: &WindowId) -> bool {
    state
        .window(window.as_str())
        .is_some_and(|w| w.kind == WindowKind::Main)
        && !state
            .windows
            .values()
            .any(|w| w.id != *window && w.kind == WindowKind::Main)
}

fn window_warning(state: &BrowserState, next: &BrowserState, window: &WindowId) -> Option<Warning> {
    if !state.settings.warn_before_closing_window || last_regular_window(state, window) {
        return None;
    }
    let w = state.window(window.as_str())?;
    let closing: Vec<TabId> = w
        .tab_ids
        .iter()
        .filter(|t| next.tab(t.as_str()).is_none() && kept_open(state, t))
        .cloned()
        .collect();
    (closing.len() >= MIN_WINDOW_TABS).then(|| close_window_warning(state, window, &closing))
}

fn last_tab_warning(state: &BrowserState, next: &BrowserState, tabs: &[TabId]) -> Option<Warning> {
    if !state.settings.warn_before_closing_last_tab || tabs.len() != 1 {
        return None;
    }
    let tab = state.tab(tabs[0].as_str())?;
    if tab.live.peek {
        return None;
    }
    let w = state.window(tab.window_id.as_str())?;
    if matches!(w.kind, WindowKind::Incognito | WindowKind::LittleArdia)
        || next.window(w.id.as_str()).is_some()
    {
        return None;
    }
    let open = unpinned_open_tabs(state, &w.id);
    (!open.is_empty()).then(|| Warning {
        kind: WarningKind::ClosingLastTab,
        ..close_window_warning(state, &w.id, &open)
    })
}

pub fn group_title(state: &BrowserState, group: &groups::TabGroup) -> String {
    let members: Vec<Member> = group
        .tab_ids
        .iter()
        .filter_map(|id| state.tab(id.as_str()))
        .map(|t| Member {
            url: &t.url,
            title: &t.title,
        })
        .collect();
    group_label(&group.name, &members)
}

fn group_warning(state: &BrowserState, group: &str) -> Option<Warning> {
    if !state.settings.warn_before_closing_tab_group {
        return None;
    }
    let g = state.groups.get(group)?;
    let root = groups::root(&state.groups, group)
        .and_then(|root| state.groups.get(root.as_str()).cloned())
        .unwrap_or_else(|| g.clone());
    if root.pinned {
        return None;
    }
    let private = state
        .window(g.window_id.as_str())
        .is_some_and(|w| w.kind == WindowKind::Incognito);
    let tabs = plural(g.tab_ids.len(), "tab");
    Some(Warning {
        kind: WarningKind::ClosingTabGroup,
        window: Some(g.window_id.clone()),
        title: format!("Close \u{201c}{}\u{201d}?", group_title(state, g)),
        message: if private {
            format!("Its {tabs} close with it.")
        } else {
            format!(
                "Its {tabs} close with it. History \u{203a} Recently Closed Groups brings it back."
            )
        },
        confirm: "Close Group".to_owned(),
        suppression: ASK_AGAIN,
    })
}

fn move_warning(state: &BrowserState, tabs: &[TabId], profile: &ProfileId) -> Option<Warning> {
    if !state.settings.warn_before_moving_tabs_to_profile {
        return None;
    }
    let listed: Vec<_> = tabs.iter().filter_map(|t| state.tab(t.as_str())).collect();
    let first = listed.first()?;
    let from = &first.profile_id;
    if from.is_incognito()
        || from == profile
        || state.engine_profile(from) == state.engine_profile(profile)
    {
        return None;
    }
    let many = listed.len() > 1;
    Some(Warning {
        kind: WarningKind::MovingTabsToProfile,
        window: Some(first.window_id.clone()),
        title: if many {
            format!("Move {} Tabs to Profile?", listed.len())
        } else {
            "Move Tab to Profile?".to_owned()
        },
        message: "Moving tabs between profiles could result in some data being lost.".to_owned(),
        confirm: if many { "Move Tabs" } else { "Move Tab" }.to_owned(),
        suppression: MOVE_ASK_AGAIN,
    })
}

pub fn warning_for(state: &BrowserState, next: &BrowserState, action: &Action) -> Option<Warning> {
    match action {
        Action::CloseWindow { window } => window_warning(state, next, window),
        Action::CloseTabs { tabs, .. } => last_tab_warning(state, next, tabs),
        Action::CloseGroup { group } => group_warning(state, group.as_str()),
        Action::MoveTabsToProfile { tabs, profile, .. } => move_warning(state, tabs, profile),
        _ => None,
    }
}

pub fn quit_warning(state: &BrowserState) -> Option<Warning> {
    state.settings.warn_before_quitting.then(|| Warning {
        kind: WarningKind::Quitting,
        window: None,
        title: QUIT_TITLE.to_owned(),
        message: QUIT_MESSAGE.to_owned(),
        confirm: "Quit".to_owned(),
        suppression: QUIT_ASK_AGAIN,
    })
}

pub fn read_pick(pick: &str) -> WarningAnswer {
    let words: Vec<&str> = pick
        .split([',', '\n'])
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect();
    WarningAnswer {
        confirmed: words.contains(&"confirm"),
        suppressed: words.contains(&"suppress"),
    }
}

pub fn test_answer(warning: &Warning, file: &Path) -> Option<WarningAnswer> {
    let dump = json!({
        "kind": "confirm",
        "warning": warning.kind.setting(),
        "title": warning.title,
        "message": warning.message,
        "confirmTitle": warning.confirm,
        "cancelTitle": CANCEL,
        "suppression": warning.suppression,
        "windowId": warning.window.as_ref().map(|w| w.as_str()),
    });
    if let Ok(bytes) = serde_json::to_vec_pretty(&dump) {
        let staged = file.with_extension("json.tmp");
        if std::fs::write(&staged, bytes).is_ok() {
            let _ = std::fs::rename(&staged, file);
        }
    }
    let mut pick_name = file.as_os_str().to_owned();
    pick_name.push(".pick");
    let pick_file = PathBuf::from(pick_name);
    let pick = std::fs::read_to_string(&pick_file).ok();
    let _ = std::fs::remove_file(&pick_file);
    pick.map(|pick| read_pick(&pick))
}

impl AppCoordinator {
    pub fn ask_warning(&self, warning: &Warning) -> oneshot::Receiver<WarningAnswer> {
        let (answer, reply) = oneshot::channel();
        let test = std::env::var(crate::control_peer::TEST_ENV).ok();
        if let Some(picked) = crate::menu_test::dialog_test_file(
            self.config.scratch,
            self.config.data_dir.as_deref(),
            test.as_deref(),
        )
        .and_then(|file| test_answer(warning, &file))
        {
            let _ = answer.send(picked);
            return reply;
        }
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::Alert;
            let alert = Alert::confirm(&warning.title, &warning.message, &warning.confirm, CANCEL)
                .suppression(warning.suppression);
            let parent = warning
                .window
                .as_ref()
                .filter(|_| self.config.hosts_native_windows)
                .and_then(|window| self.engine_window(window))
                .and_then(|engine_window| {
                    self.engine()
                        .and_then(|engine| engine.native_window_handle(engine_window).ok())
                });
            let sheet = parent.is_some();
            let shown = alert.show(parent.as_ref());
            let kind = warning.kind;
            self.spawn(async move {
                let mut response = shown.await;
                if sheet && let Err(problem) = &response {
                    log::info!(
                        "{kind:?} couldn't attach to its window ({problem}), so it asks app-wide"
                    );
                    response = alert.show(None).await;
                }
                let answered = match response {
                    Ok(response) => WarningAnswer {
                        confirmed: response.chose(0),
                        suppressed: response.suppressed,
                    },
                    Err(problem) => {
                        log::warn!("{kind:?} couldn't be shown ({problem}), so nothing changes");
                        WarningAnswer::default()
                    }
                };
                let _ = answer.send(answered);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            log::warn!(
                "{:?} has no dialog on this platform, so nothing changes",
                warning.kind
            );
            let _ = answer.send(WarningAnswer::default());
        }
        reply
    }

    pub(crate) fn warn_before(&self, action: &Action) -> bool {
        if warnings_paused()
            || !may_warn(action)
            || crate::sync_engine::pin_choices::writing_from_sync()
            || self.is_shutting_down()
        {
            return false;
        }
        let state = self.store().snapshot();
        let Ok((next, _)) = state.reduce(
            action.clone(),
            ardia_state::store::now_ms(),
            self.store().ids(),
        ) else {
            return false;
        };
        let Some(warning) = warning_for(&state, &next, action) else {
            return false;
        };
        if ASKING.with(|a| a.replace(true)) {
            log::debug!(
                "a warning is already up, so {:?} waits for it",
                warning.kind
            );
            return true;
        }
        log::info!("asking before {:?}: {}", warning.kind, warning.title);
        let reply = self.ask_warning(&warning);
        let me = self.weak();
        let action = action.clone();
        let kind = warning.kind;
        self.spawn(async move {
            let answer = reply.await.unwrap_or_default();
            ASKING.with(|a| a.set(false));
            let Some(me) = me.upgrade() else {
                return;
            };
            log::info!("{kind:?} answered {answer:?}");
            if answer.suppressed {
                let _ = me.dispatch_action(Action::UpdateSettings {
                    patch: kind.silenced(),
                    from_sync: false,
                });
            }
            if answer.confirmed
                && let Err(problem) = without_warnings(|| me.dispatch_action(action))
            {
                log::debug!("the warned action changed nothing: {problem}");
            }
        });
        true
    }

    pub fn request_quit_from_user(&self) {
        let state = self.store().snapshot();
        let Some(warning) = quit_warning(&state).filter(|_| !self.is_shutting_down()) else {
            self.request_quit();
            return;
        };
        if ASKING.with(|a| a.replace(true)) {
            return;
        }
        log::info!("asking before quitting");
        let reply = self.ask_warning(&warning);
        let me = self.weak();
        self.spawn(async move {
            let answer = reply.await.unwrap_or_default();
            ASKING.with(|a| a.set(false));
            let Some(me) = me.upgrade() else {
                return;
            };
            log::info!("the quit warning answered {answer:?}");
            if answer.suppressed {
                let _ = me.dispatch_action(Action::UpdateSettings {
                    patch: WarningKind::Quitting.silenced(),
                    from_sync: false,
                });
            }
            if answer.confirmed {
                me.request_quit();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::NewTab;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};

    struct World {
        state: BrowserState,
        ids: IdGen,
    }

    impl World {
        fn new() -> Self {
            World {
                state: BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1),
                ids: IdGen::with_launch("warn"),
            }
        }

        fn act(&mut self, action: Action) -> ardia_state::Outcome {
            self.state.apply(action, 2, &self.ids).expect("action")
        }

        fn window(&mut self, urls: &[&str]) -> WindowId {
            let window = self
                .act(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: None,
                    url: Some(urls[0].to_owned()),
                    frame: None,
                })
                .window
                .expect("window");
            for url in &urls[1..] {
                self.act(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some((*url).to_owned()),
                        ..NewTab::default()
                    },
                });
            }
            window
        }

        fn warning(&self, action: &Action) -> Option<Warning> {
            let (next, _) = self.state.reduce(action.clone(), 3, &self.ids).ok()?;
            warning_for(&self.state, &next, action)
        }

        fn set(&mut self, key: &str, on: bool) {
            self.act(Action::UpdateSettings {
                patch: SettingsPatch::new().set(key, on),
                from_sync: false,
            });
        }

        fn tabs(&self, window: &WindowId) -> Vec<TabId> {
            self.state.window(window.as_str()).unwrap().tab_ids.clone()
        }
    }

    #[test]
    fn closing_a_window_with_tabs_asks_unless_it_is_the_last_one() {
        let mut w = World::new();
        let first = w.window(&["https://a.example", "https://b.example"]);
        let close_first = Action::CloseWindow { window: first };
        assert_eq!(
            w.warning(&close_first),
            None,
            "the last window keeps its tabs"
        );
        let second = w.window(&[
            "https://c.example",
            "https://d.example",
            "https://e.example",
        ]);
        let asked = w
            .warning(&Action::CloseWindow {
                window: second.clone(),
            })
            .expect("a window with three tabs asks");
        assert_eq!(asked.kind, WarningKind::ClosingWindow);
        assert_eq!(asked.title, "Close 3 tabs?");
        assert_eq!(asked.confirm, "Close All Tabs");
        assert!(
            asked
                .message
                .starts_with("This window has 3 tabs open in your "),
            "{}",
            asked.message
        );
        assert!(asked.message.ends_with(" profile."));
        assert_eq!(asked.suppression, ASK_AGAIN);
        w.set("warnBeforeClosingWindow", false);
        assert_eq!(w.warning(&Action::CloseWindow { window: second }), None);
    }

    #[test]
    fn closing_the_last_tab_asks_before_its_window_goes() {
        let mut w = World::new();
        w.window(&["https://a.example"]);
        let second = w.window(&["https://b.example"]);
        let tab = w.tabs(&second)[0].clone();
        let close = Action::CloseTabs {
            tabs: vec![tab.clone()],
            last_closes_window: true,
        };
        let asked = w.warning(&close).expect("the window would close");
        assert_eq!(asked.kind, WarningKind::ClosingLastTab);
        assert_eq!(asked.title, "Close 1 tab?");
        assert_eq!(asked.confirm, "Close Tab");
        assert_eq!(
            w.warning(&Action::CloseTabs {
                tabs: vec![tab],
                last_closes_window: false,
            }),
            None,
            "a tab that leaves a fresh tab behind doesn't ask"
        );
        w.set("warnBeforeClosingLastTab", false);
        assert_eq!(w.warning(&close), None);
    }

    #[test]
    fn closing_a_group_names_it_and_spares_pinned_ones() {
        let mut w = World::new();
        let window = w.window(&["https://a.example", "https://b.example"]);
        let tabs = w.tabs(&window);
        let group = w
            .act(Action::CreateGroup {
                tabs,
                name: "Work".into(),
            })
            .group
            .expect("group");
        let asked = w
            .warning(&Action::CloseGroup {
                group: group.clone(),
            })
            .expect("groups ask");
        assert_eq!(asked.title, "Close \u{201c}Work\u{201d}?");
        assert_eq!(
            asked.message,
            "Its 2 tabs close with it. History \u{203a} Recently Closed Groups brings it back."
        );
        assert_eq!(asked.confirm, "Close Group");
        w.set("warnBeforeClosingTabGroup", false);
        assert_eq!(w.warning(&Action::CloseGroup { group }), None);
    }

    #[test]
    fn moving_tabs_to_another_profile_warns_about_data() {
        let mut w = World::new();
        let window = w.window(&["https://a.example", "https://b.example"]);
        let profile = w
            .act(Action::CreateProfile {
                name: "Work".into(),
                color: None,
                icon: None,
            })
            .profile
            .expect("profile");
        let tabs = w.tabs(&window);
        let one = Action::MoveTabsToProfile {
            tabs: vec![tabs[0].clone()],
            profile: profile.clone(),
            before: None,
            background: true,
        };
        let asked = w.warning(&one).expect("a separate profile warns");
        assert_eq!(asked.title, "Move Tab to Profile?");
        assert_eq!(asked.confirm, "Move Tab");
        assert_eq!(asked.suppression, MOVE_ASK_AGAIN);
        let both = Action::MoveTabsToProfile {
            tabs,
            profile,
            before: None,
            background: true,
        };
        assert_eq!(
            w.warning(&both).expect("two tabs").title,
            "Move 2 Tabs to Profile?"
        );
        w.set("warnBeforeMovingTabsToProfile", false);
        assert_eq!(w.warning(&both), None);
    }

    #[test]
    fn quitting_asks_only_when_turned_on() {
        let mut w = World::new();
        assert_eq!(quit_warning(&w.state), None);
        w.set("warnBeforeQuitting", true);
        let asked = quit_warning(&w.state).expect("asks");
        assert_eq!(asked.title, QUIT_TITLE);
        assert_eq!(asked.message, QUIT_MESSAGE);
        assert_eq!(asked.suppression, QUIT_ASK_AGAIN);
    }

    #[test]
    fn a_pick_uses_the_old_confirm_and_suppress_words() {
        assert_eq!(
            read_pick("confirm,suppress\n"),
            WarningAnswer {
                confirmed: true,
                suppressed: true
            }
        );
        assert_eq!(read_pick("cancel"), WarningAnswer::default());
        assert_eq!(
            read_pick("suppress"),
            WarningAnswer {
                confirmed: false,
                suppressed: true
            }
        );
        assert_eq!(read_pick(""), WarningAnswer::default());
    }

    #[test]
    fn without_a_pick_the_real_alert_answers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("dialog.json");
        let warning = quit_warning(&{
            let mut w = World::new();
            w.set("warnBeforeQuitting", true);
            w.state
        })
        .unwrap();
        assert_eq!(test_answer(&warning, &file), None);
        let dumped: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(dumped["kind"], "confirm");
        assert_eq!(dumped["confirmTitle"], "Quit");
        assert_eq!(dumped["suppression"], QUIT_ASK_AGAIN);
        std::fs::write(dir.path().join("dialog.json.pick"), "confirm").unwrap();
        assert_eq!(
            test_answer(&warning, &file),
            Some(WarningAnswer {
                confirmed: true,
                suppressed: false
            })
        );
        assert!(!dir.path().join("dialog.json.pick").exists());
    }

    #[test]
    fn each_warning_silences_its_own_setting() {
        assert_eq!(
            WarningKind::ClosingLastTab.silenced(),
            SettingsPatch::new().set("warnBeforeClosingLastTab", false)
        );
        assert_eq!(WarningKind::Quitting.setting(), "warnBeforeQuitting");
    }

    #[test]
    fn confirmed_actions_skip_the_warnings_once() {
        assert!(!warnings_paused());
        assert!(without_warnings(warnings_paused));
        assert!(!warnings_paused());
    }
}
