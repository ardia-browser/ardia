use std::time::{Duration, Instant};

use ardia_engine::EngineTabId;
use ardia_state::actions::Action;
use ardia_state::actions::PageUpdate;
use ardia_state::settings::{NewTabLinksOpenIn, PeekModifier};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, TabId, WindowId};

use crate::coordinator::AppCoordinator;
use crate::peek_links::{KEY_SHIFT, MouseUp};

pub const CLICK_LIFETIME: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRoute {
    Tab,
    Peek,
    LittleArdia,
    InPlace,
}

pub fn click_keys(mouse: &MouseUp, now: Instant, test_hooks: bool) -> Option<u8> {
    let fresh = mouse
        .at
        .is_some_and(|at| now.saturating_duration_since(at) <= CLICK_LIFETIME)
        && !mouse.pressed_since;
    if fresh {
        Some(mouse.keys)
    } else {
        test_hooks.then_some(0)
    }
}

fn web(url: &str) -> bool {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    (!host.is_empty()).then_some(host)
}

pub fn leaves_site(url: &str, page_url: &str) -> bool {
    host(url).is_some_and(|to| Some(to) != host(page_url))
}

pub fn route(
    state: &BrowserState,
    window: &WindowId,
    opener: Option<&TabId>,
    url: &str,
    disposition: &str,
    keys: Option<u8>,
) -> LinkRoute {
    let Some(w) = state.window(window.as_str()) else {
        return LinkRoute::Tab;
    };
    let Some(source) = opener.and_then(|id| state.tab(id.as_str())) else {
        return LinkRoute::Tab;
    };
    if source.window_id != w.id || !web(url) {
        return LinkRoute::Tab;
    }
    if w.kind == WindowKind::LittleArdia {
        let plain = disposition == "foreground_tab" && keys == Some(0);
        return if plain && state.settings.little_ardia_opens_new_tab_links {
            LinkRoute::InPlace
        } else {
            LinkRoute::Tab
        };
    }
    if w.kind != WindowKind::Main || source.live.peek {
        return LinkRoute::Tab;
    }
    match disposition {
        "window" => {
            let shifted = matches!(keys, Some(KEY_SHIFT) | Some(0));
            if shifted && state.settings.peek_modifier == PeekModifier::Shift {
                LinkRoute::Peek
            } else {
                LinkRoute::Tab
            }
        }
        "foreground_tab" if keys == Some(0) => {
            if crate::peek_links::peeks_other_sites(state, &source.id)
                && leaves_site(url, &source.url)
            {
                return LinkRoute::Peek;
            }
            match state.settings.new_tab_links_open_in {
                NewTabLinksOpenIn::Peek => LinkRoute::Peek,
                NewTabLinksOpenIn::LittleArdia => LinkRoute::LittleArdia,
                NewTabLinksOpenIn::Tab => LinkRoute::Tab,
            }
        }
        _ => LinkRoute::Tab,
    }
}

impl AppCoordinator {
    pub(crate) fn route_page_link(
        &self,
        engine_tab: EngineTabId,
        window: &WindowId,
        opener: Option<&TabId>,
        disposition: &str,
        url: &str,
    ) -> bool {
        let state = self.store().snapshot();
        let keys = click_keys(
            &crate::peek_links::last_mouse_up(),
            Instant::now(),
            crate::peek_links::peek_test_hooks(),
        );
        let Some(opener) = opener else {
            return false;
        };
        match route(&state, window, Some(opener), url, disposition, keys) {
            LinkRoute::Tab => false,
            LinkRoute::Peek => {
                let opened = self.store().dispatch(Action::OpenPeek {
                    window: window.clone(),
                    url: url.to_owned(),
                    source: Some(opener.clone()),
                });
                match opened.ok().and_then(|outcome| outcome.tab) {
                    Some(peek) => {
                        log::info!("a {disposition} link from {opener} opens in a peek");
                        crate::peek_links::spend_mouse_up();
                        self.bind_tab(&peek, engine_tab, window);
                        true
                    }
                    None => false,
                }
            }
            LinkRoute::InPlace => {
                log::info!("Little Ardia opens a new-tab link from {opener} in place");
                self.bridge.lock().closing_tabs.insert(engine_tab);
                if let Some(engine) = self.engine() {
                    let _ = engine.close_now(engine_tab);
                }
                ardia_ui::UiHost::navigate(self, window.clone(), opener.clone(), url.to_owned());
                true
            }
            LinkRoute::LittleArdia => {
                let profile = state.tab(opener.as_str()).map(|t| t.profile_id.clone());
                let opened = self.store().dispatch(Action::OpenWindow {
                    kind: WindowKind::LittleArdia,
                    profile,
                    url: None,
                    frame: None,
                });
                let Some((little, Some(placeholder))) = opened
                    .ok()
                    .and_then(|outcome| outcome.window.map(|w| (w, outcome.tab)))
                else {
                    return false;
                };
                log::info!("a new-tab link from {opener} opens in Little Ardia");
                {
                    let mut bridge = self.bridge.lock();
                    bridge
                        .placeholders
                        .insert(little.clone(), placeholder.clone());
                    bridge.strays.insert(little, engine_tab);
                }
                self.dispatch_quietly(Action::UpdatePage {
                    tab: placeholder,
                    update: PageUpdate {
                        url: Some(url.to_owned()),
                        ..PageUpdate::default()
                    },
                });
                self.mark_dirty();
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::Action;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use ardia_state::settings::SettingsPatch;

    fn act(state: &mut BrowserState, ids: &IdGen, action: Action) -> ardia_state::Outcome {
        state.apply(action, 2, ids).expect("action")
    }

    fn setting(state: &mut BrowserState, ids: &IdGen, key: &str, value: &str) {
        act(
            state,
            ids,
            Action::UpdateSettings {
                patch: SettingsPatch::new().set(key, value),
                from_sync: false,
            },
        );
    }

    fn browser(kind: WindowKind) -> (BrowserState, IdGen, WindowId, TabId) {
        let ids = IdGen::with_launch("links");
        let mut state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1);
        act(
            &mut state,
            &ids,
            Action::OpenWindow {
                kind,
                profile: None,
                url: Some("https://a.example/page".into()),
                frame: None,
            },
        );
        let window = state
            .window_order
            .iter()
            .find(|w| state.window(w.as_str()).is_some_and(|w| w.kind == kind))
            .cloned()
            .expect("window");
        let tab = state.active_tab(window.as_str()).expect("tab").id.clone();
        (state, ids, window, tab)
    }

    #[test]
    fn plain_clicks_on_new_tab_links_follow_the_setting() {
        let (mut state, ids, window, tab) = browser(WindowKind::Main);
        let go = |s: &BrowserState, keys| {
            route(
                s,
                &window,
                Some(&tab),
                "https://b.example/",
                "foreground_tab",
                keys,
            )
        };
        assert_eq!(go(&state, Some(0)), LinkRoute::Peek);
        assert_eq!(
            go(&state, Some(KEY_SHIFT | crate::peek_links::KEY_COMMAND)),
            LinkRoute::Tab
        );
        assert_eq!(go(&state, None), LinkRoute::Tab);
        setting(&mut state, &ids, "newTabLinksOpenIn", "littleArdia");
        assert_eq!(go(&state, Some(0)), LinkRoute::LittleArdia);
        setting(&mut state, &ids, "newTabLinksOpenIn", "tab");
        assert_eq!(go(&state, Some(0)), LinkRoute::Tab);
        assert_eq!(
            route(
                &state,
                &window,
                Some(&tab),
                "file:///x",
                "foreground_tab",
                Some(0)
            ),
            LinkRoute::Tab
        );
        assert_eq!(
            route(
                &state,
                &window,
                Some(&tab),
                "https://b.example/",
                "background_tab",
                Some(0)
            ),
            LinkRoute::Tab
        );
    }

    #[test]
    fn shift_click_windows_fall_back_to_peek_with_the_shift_modifier() {
        let (mut state, ids, window, tab) = browser(WindowKind::Main);
        let go = |s: &BrowserState| {
            route(
                s,
                &window,
                Some(&tab),
                "https://b.example/",
                "window",
                Some(KEY_SHIFT),
            )
        };
        assert_eq!(go(&state), LinkRoute::Peek);
        setting(&mut state, &ids, "peekModifier", "alt");
        assert_eq!(go(&state), LinkRoute::Tab);
        assert_eq!(
            route(
                &state,
                &window,
                Some(&tab),
                "https://b.example/",
                "popup",
                Some(KEY_SHIFT)
            ),
            LinkRoute::Tab
        );
    }

    #[test]
    fn little_ardia_opens_new_tab_links_in_place_when_asked() {
        let (mut state, ids, window, tab) = browser(WindowKind::LittleArdia);
        let go = |s: &BrowserState| {
            route(
                s,
                &window,
                Some(&tab),
                "https://b.example/",
                "foreground_tab",
                Some(0),
            )
        };
        assert_eq!(go(&state), LinkRoute::InPlace);
        act(
            &mut state,
            &ids,
            Action::UpdateSettings {
                patch: SettingsPatch::new().set("littleArdiaOpensNewTabLinks", false),
                from_sync: false,
            },
        );
        assert_eq!(go(&state), LinkRoute::Tab);
    }

    #[test]
    fn links_from_a_peek_stay_tabs() {
        let (mut state, ids, window, tab) = browser(WindowKind::Main);
        let peek = act(
            &mut state,
            &ids,
            Action::OpenPeek {
                window: window.clone(),
                url: "https://c.example".into(),
                source: Some(tab),
            },
        )
        .tab
        .expect("peek");
        assert_eq!(
            route(
                &state,
                &window,
                Some(&peek),
                "https://b.example/",
                "foreground_tab",
                Some(0)
            ),
            LinkRoute::Tab
        );
    }

    #[test]
    fn the_click_must_be_fresh_unless_tests_drive_it() {
        let now = Instant::now();
        let mouse = MouseUp {
            at: Some(now),
            keys: KEY_SHIFT,
            seq: 1,
            used: 0,
            pressed_since: false,
        };
        assert_eq!(click_keys(&mouse, now, false), Some(KEY_SHIFT));
        assert_eq!(
            click_keys(&mouse, now + Duration::from_secs(3), false),
            None
        );
        assert_eq!(
            click_keys(&mouse, now + Duration::from_secs(3), true),
            Some(0)
        );
        assert_eq!(click_keys(&MouseUp::default(), now, false), None);
    }

    #[test]
    fn leaving_the_site_compares_hosts() {
        assert!(leaves_site("https://b.example/x", "https://a.example/"));
        assert!(!leaves_site(
            "https://www.a.example/x",
            "https://a.example/y"
        ));
        assert!(!leaves_site("about:blank", "https://a.example/"));
    }
}
