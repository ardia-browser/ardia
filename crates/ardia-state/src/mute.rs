use crate::omnibox::url::host_of;
use crate::state::BrowserState;
use crate::tabs::Tab;
use crate::{Action, TabId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuteState {
    Site,
    Tab,
}

fn host_muted(state: &BrowserState, tab: &Tab, host: &str) -> bool {
    let own = tab
        .is_incognito()
        .then(|| {
            state
                .private_site_mutes
                .get(&tab.window_id)
                .and_then(|hosts| hosts.get(host).copied())
        })
        .flatten();
    own.unwrap_or_else(|| state.settings.muted_sites.iter().any(|h| h == host))
}

pub fn site_muted(state: &BrowserState, tab: &Tab) -> bool {
    let any_muted = !state.settings.muted_sites.is_empty()
        || (tab.is_incognito() && state.private_site_mutes.contains_key(&tab.window_id));
    if !any_muted || tab.url.is_empty() {
        return false;
    }
    let host = host_of(&tab.url);
    !host.is_empty() && host_muted(state, tab, &host)
}

pub fn silenced(state: &BrowserState, tab: &Tab) -> bool {
    tab.muted || site_muted(state, tab)
}

pub fn mute_state(state: &BrowserState, tab: &Tab) -> Option<MuteState> {
    if site_muted(state, tab) {
        Some(MuteState::Site)
    } else if tab.muted {
        Some(MuteState::Tab)
    } else {
        None
    }
}

pub fn mute_title(state: Option<MuteState>) -> &'static str {
    match state {
        Some(MuteState::Site) => "Unmute Site",
        Some(MuteState::Tab) => "Unmute Tab",
        None => "Mute Tab",
    }
}

pub fn site_mute_title(state: Option<MuteState>) -> &'static str {
    match state {
        Some(MuteState::Site) => "Unmute Site",
        _ => "Mute Site",
    }
}

pub fn toggle_mute(state: &BrowserState, tab: &Tab) -> Vec<Action> {
    if !site_muted(state, tab) {
        return vec![Action::SetMuted {
            tab: tab.id.clone(),
            muted: !tab.muted,
        }];
    }
    let mut actions = vec![Action::SetSiteMuted {
        tab: tab.id.clone(),
        muted: false,
    }];
    if tab.muted {
        actions.push(Action::SetMuted {
            tab: tab.id.clone(),
            muted: false,
        });
    }
    actions
}

pub fn toggle_site_mute(state: &BrowserState, tab: &Tab) -> Vec<Action> {
    vec![Action::SetSiteMuted {
        tab: tab.id.clone(),
        muted: !site_muted(state, tab),
    }]
}

pub fn toggle(state: &BrowserState, tab: &TabId, site: bool) -> Vec<Action> {
    match state.tab(tab.as_str()) {
        Some(tab) if site => toggle_site_mute(state, tab),
        Some(tab) => toggle_mute(state, tab),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::NewTab;
    use crate::ids::IdGen;
    use crate::store::BrowserStore;
    use crate::windows::WindowKind;

    fn tab_in(kind: WindowKind, url: &str) -> (BrowserStore, TabId) {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("m"));
        store
            .dispatch(Action::OpenWindow {
                kind,
                profile: None,
                url: None,
                frame: None,
            })
            .ok();
        let window = store
            .read(|state| state.windows.keys().next().cloned())
            .expect("a window");
        let tab = store
            .dispatch(Action::NewTab {
                window,
                tab: NewTab {
                    url: Some(url.to_owned()),
                    ..NewTab::default()
                },
            })
            .expect("a tab")
            .tab
            .expect("a new tab");
        (store, tab)
    }

    fn run(store: &BrowserStore, actions: Vec<Action>) {
        for action in actions {
            store.dispatch(action).expect("the action applies");
        }
    }

    fn state_of(store: &BrowserStore, tab: &TabId) -> (Option<MuteState>, bool, bool) {
        store.read(|s| {
            let t = s.tab(tab.as_str()).expect("the tab");
            (mute_state(s, t), silenced(s, t), t.muted)
        })
    }

    #[test]
    fn muting_a_site_silences_its_tabs_without_muting_the_tab_itself() {
        let (store, tab) = tab_in(WindowKind::Main, "https://www.music.test/a");
        run(&store, store.read(|s| toggle(s, &tab, true)));
        assert_eq!(state_of(&store, &tab), (Some(MuteState::Site), true, false));
        assert_eq!(
            store.read(|s| s.settings.muted_sites.clone()),
            vec!["music.test".to_owned()]
        );
        assert_eq!(mute_title(Some(MuteState::Site)), "Unmute Site");
        run(&store, store.read(|s| toggle(s, &tab, false)));
        assert_eq!(state_of(&store, &tab), (None, false, false));
        assert!(store.read(|s| s.settings.muted_sites.is_empty()));
    }

    #[test]
    fn unmuting_a_site_muted_tab_also_clears_its_own_mute() {
        let (store, tab) = tab_in(WindowKind::Main, "https://music.test/");
        run(&store, store.read(|s| toggle(s, &tab, false)));
        assert_eq!(state_of(&store, &tab), (Some(MuteState::Tab), true, true));
        run(&store, store.read(|s| toggle(s, &tab, true)));
        assert_eq!(state_of(&store, &tab).0, Some(MuteState::Site));
        run(&store, store.read(|s| toggle(s, &tab, false)));
        assert_eq!(state_of(&store, &tab), (None, false, false));
    }

    #[test]
    fn private_windows_keep_their_site_mutes_to_themselves() {
        let (store, tab) = tab_in(WindowKind::Incognito, "https://music.test/");
        run(&store, store.read(|s| toggle(s, &tab, true)));
        assert_eq!(state_of(&store, &tab), (Some(MuteState::Site), true, false));
        assert!(store.read(|s| s.settings.muted_sites.is_empty()));
    }
}
