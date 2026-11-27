use ardia_state::air_traffic::{LinkSource, OpenAs};
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserState, GroupId, ProfileId, WindowId};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkPlan {
    NewTab {
        window: WindowId,
        profile: ProfileId,
        group: Option<GroupId>,
    },
    NewWindow {
        kind: WindowKind,
        profile: ProfileId,
    },
}

pub fn plan_link(state: &BrowserState, url: &str, source: &LinkSource) -> LinkPlan {
    let decision = state.route_link(url, source);
    match decision.by {
        Some(ardia_state::air_traffic::RoutedBy::Rule(_)) => {
            ardia_telemetry::counts::count("air_traffic_rule_links")
        }
        Some(ardia_state::air_traffic::RoutedBy::Fallback) => {
            ardia_telemetry::counts::count("air_traffic_fallback_links")
        }
        None => {}
    }
    let setting_on = state.settings.open_links_in_little_ardia;
    ardia_telemetry::counts::count(match (decision.open == OpenAs::LittleArdia, setting_on) {
        (true, true) => "external_links_little_setting_on",
        (true, false) => "external_links_little_setting_off",
        (false, true) => "external_links_tab_setting_on",
        (false, false) => "external_links_tab_setting_off",
    });
    let profile = decision.profile_id;
    match decision.open {
        OpenAs::Window => LinkPlan::NewWindow {
            kind: WindowKind::Main,
            profile,
        },
        OpenAs::LittleArdia => LinkPlan::NewWindow {
            kind: WindowKind::LittleArdia,
            profile,
        },
        OpenAs::Tab => {
            let group = decision.group_key.as_deref().and_then(|key| {
                state
                    .groups
                    .values()
                    .find(|group| group.profile_id == profile && group.pin_key() == key)
                    .filter(|group| {
                        state
                            .windows
                            .get(&group.window_id)
                            .is_some_and(|window| window.kind == WindowKind::Main)
                    })
            });
            if let Some(group) = group {
                return LinkPlan::NewTab {
                    window: group.window_id.clone(),
                    profile,
                    group: Some(group.id.clone()),
                };
            }
            match state.main_window_for(Some(&profile)) {
                Some(window) => LinkPlan::NewTab {
                    window: window.clone(),
                    profile,
                    group: None,
                },
                None => LinkPlan::NewWindow {
                    kind: WindowKind::Main,
                    profile,
                },
            }
        }
    }
}

pub fn runs_javascript(url: &str) -> bool {
    let trimmed = url.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    let scheme: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .take(11)
        .collect();
    scheme.eq_ignore_ascii_case("javascript:")
}

pub fn app_link_index(
    state: &BrowserState,
    window: &WindowId,
    profile: &ProfileId,
    batch_index: usize,
) -> Option<usize> {
    if !state.settings.app_links_first {
        return None;
    }
    let w = state.window(window.as_str())?;
    let first = w
        .tab_ids
        .iter()
        .position(|id| {
            state
                .tab(id.as_str())
                .is_some_and(|t| t.profile_id == *profile)
                && !state.in_pinned_container(id.as_str())
        })
        .unwrap_or(w.tab_ids.len());
    Some((first + batch_index).min(w.tab_ids.len()))
}

pub fn is_openable(url: &str) -> bool {
    let url = url.trim();
    !url.is_empty() && url.len() <= 32 * 1024 && !url.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::Action;
    use ardia_state::air_traffic::AirTrafficConfig;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use serde_json::json;

    fn state() -> BrowserState {
        BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1)
    }

    fn links_in_main_window(state: &mut BrowserState) {
        act(
            state,
            Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new()
                    .set("openLinksInLittleArdia", false),
                from_sync: false,
            },
        );
    }

    fn act(state: &mut BrowserState, action: Action) -> ardia_state::Outcome {
        state
            .apply(action, 2, &IdGen::with_launch("links"))
            .unwrap()
    }

    #[test]
    fn links_land_in_the_last_main_window_or_a_new_one() {
        let mut s = state();
        assert!(
            matches!(
                plan_link(&s, "https://a.example", &LinkSource::default()),
                LinkPlan::NewWindow {
                    kind: WindowKind::LittleArdia,
                    ..
                }
            ),
            "links from other apps open in Little Ardia by default"
        );
        links_in_main_window(&mut s);
        assert_eq!(
            plan_link(&s, "https://a.example", &LinkSource::default()),
            LinkPlan::NewWindow {
                kind: WindowKind::Main,
                profile: ProfileId::default_profile()
            }
        );
        let window = act(
            &mut s,
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            },
        )
        .window
        .unwrap();
        assert_eq!(
            plan_link(&s, "https://a.example", &LinkSource::default()),
            LinkPlan::NewTab {
                window,
                profile: ProfileId::default_profile(),
                group: None
            }
        );
    }

    #[test]
    fn air_traffic_rules_send_sites_to_little_ardia() {
        let mut s = state();
        let config = AirTrafficConfig::from_value(&json!({
            "version": 2,
            "rules": [{
                "id": "r1",
                "enabled": true,
                "from": null,
                "when": {"kind": "site", "host": "news.example"},
                "open": "littleArdia",
                "profileId": null
            }]
        }));
        assert_eq!(config.rules.len(), 1);
        act(&mut s, Action::SetAirTraffic { config });
        assert!(matches!(
            plan_link(&s, "https://news.example/today", &LinkSource::default()),
            LinkPlan::NewWindow {
                kind: WindowKind::LittleArdia,
                ..
            }
        ));
        links_in_main_window(&mut s);
        assert!(
            matches!(
                plan_link(&s, "https://news.example/today", &LinkSource::default()),
                LinkPlan::NewWindow {
                    kind: WindowKind::LittleArdia,
                    ..
                }
            ),
            "a rule beats the setting"
        );
        assert!(matches!(
            plan_link(&s, "https://other.example", &LinkSource::default()),
            LinkPlan::NewWindow {
                kind: WindowKind::Main,
                ..
            }
        ));
        assert!(
            is_openable(" https://x\n") && !is_openable(" ") && !is_openable("https://x\u{7}y")
        );
    }

    #[test]
    fn javascript_links_are_spotted_through_case_and_spaces() {
        assert!(runs_javascript("javascript:alert(1)"));
        assert!(runs_javascript("  JavaScript:void 0"));
        assert!(!runs_javascript("https://javascript.info"));
        assert!(!runs_javascript("java"));
        assert!(runs_javascript("java\tscript:alert(1)"));
        assert!(runs_javascript("\u{1}j\na\rvascript:alert(1)"));
        assert!(!runs_javascript("java script:alert(1)"));
    }

    #[test]
    fn app_links_land_first_among_regular_tabs_when_asked() {
        let mut s = state();
        let window = act(
            &mut s,
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example".into()),
                frame: None,
            },
        )
        .window
        .unwrap();
        let profile = ProfileId::default_profile();
        assert_eq!(app_link_index(&s, &window, &profile, 0), None);
        act(
            &mut s,
            Action::UpdateSettings {
                patch: ardia_state::settings::SettingsPatch::new().set("appLinksFirst", true),
                from_sync: false,
            },
        );
        let first = s
            .window(window.as_str())
            .unwrap()
            .tab_ids
            .iter()
            .position(|t| !s.in_pinned_container(t.as_str()))
            .unwrap();
        assert_eq!(app_link_index(&s, &window, &profile, 0), Some(first));
        assert_eq!(app_link_index(&s, &window, &profile, 1), Some(first + 1));
    }
}
