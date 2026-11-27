mod common;

use ardia_state::actions::Action;
use ardia_state::air_traffic::{AirTrafficConfig, LinkSource, OpenAs, RoutedBy};
use ardia_state::ids::ProfileId;
use ardia_state::persistence::DataDir;
use ardia_state::persistence::session::LoadOptions;
use ardia_state::settings::SettingsPatch;
use ardia_state::store::BrowserStore;
use ardia_state::windows::WindowKind;
use common::World;
use serde_json::json;
use std::time::Duration;

fn slack() -> LinkSource {
    LinkSource {
        bundle_id: Some("com.tinyspeck.slackmacgap".into()),
        app_name: Some("Slack".into()),
    }
}

fn mail() -> LinkSource {
    LinkSource {
        bundle_id: Some("com.apple.mail".into()),
        app_name: Some("Mail".into()),
    }
}

fn rules(work: &ProfileId, group_key: &str) -> AirTrafficConfig {
    AirTrafficConfig::from_value(&json!({
        "version": 2,
        "rules": [
            {"id": "r-gh", "enabled": true, "from": {"bundleId": "com.tinyspeck.slackmacgap", "name": "Slack"}, "when": {"kind": "site", "host": "github.com"}, "profileId": work.as_str(), "open": "tab", "groupKey": group_key},
            {"id": "r-gone", "enabled": true, "from": null, "when": {"kind": "site", "host": "figma.com"}, "profileId": "p-deleted", "open": "window"},
            {"id": "r-docs", "enabled": true, "from": null, "when": {"kind": "pattern", "pattern": "https://*.example.com/docs/*"}, "profileId": null, "open": "littleArdia"}
        ],
        "fallback": null,
        "fallbackChosen": false
    }))
}

#[test]
fn links_without_a_rule_go_to_the_last_active_profile() {
    let mut w = World::new();
    w.open();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    let decision = w.state.route_link("https://news.ycombinator.com/", &mail());
    assert_eq!(decision.profile_id, w.default_profile());
    assert_eq!(
        decision.open,
        OpenAs::LittleArdia,
        "links open in Little Ardia by default"
    );
    assert_eq!(decision.by, None);
    let win = w.state.window_order[0].clone();
    w.act(Action::SwitchProfile {
        window: win,
        profile: work.clone(),
    });
    w.act(Action::UpdateSettings {
        patch: SettingsPatch::new().set("openLinksInLittleArdia", false),
        from_sync: false,
    });
    let decision = w.state.route_link("https://news.ycombinator.com/", &mail());
    assert_eq!(decision.profile_id, work);
    assert_eq!(decision.open, OpenAs::Tab);
}

#[test]
fn rules_pick_the_profile_and_keep_groups_only_when_they_exist() {
    let mut w = World::new();
    let win = w.open();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    w.act(Action::SetAirTraffic {
        config: rules(&work, "g-missing"),
    });
    let decision = w
        .state
        .route_link("https://github.com/ardia-browser/ardia", &slack());
    assert_eq!(decision.profile_id, work);
    assert_eq!(
        decision.by,
        Some(RoutedBy::Rule(ardia_state::ids::RuleId::new("r-gh")))
    );
    assert_eq!(
        decision.group_key, None,
        "a rule's group that no longer exists is ignored"
    );
    let from_mail = w.state.route_link("https://github.com/", &mail());
    assert_eq!(from_mail.by, None, "the rule only covers links from Slack");
    w.act(Action::SwitchProfile {
        window: win.clone(),
        profile: work.clone(),
    });
    let tab = w.open_tab(&win, "github.com");
    let group = w
        .act(Action::CreateGroup {
            tabs: vec![tab],
            name: "Reviews".into(),
        })
        .group
        .unwrap();
    w.act(Action::SetAirTraffic {
        config: rules(&work, group.as_str()),
    });
    assert_eq!(
        w.state
            .route_link("https://github.com/x", &slack())
            .group_key
            .as_deref(),
        Some(group.as_str())
    );
    let gone = w.state.route_link("https://figma.com/file/1", &mail());
    assert_eq!(gone.by, None, "rules for deleted profiles are skipped");
    let docs = w
        .state
        .route_link("https://api.example.com/docs/start", &mail());
    assert_eq!(docs.open, OpenAs::LittleArdia);
    assert_eq!(
        docs.profile_id, work,
        "a rule without a profile uses the last active one"
    );
}

#[test]
fn private_and_little_windows_never_become_the_link_profile() {
    let mut w = World::new();
    let main = w.open();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    w.act(Action::SwitchProfile {
        window: main,
        profile: work.clone(),
    });
    w.act(Action::OpenWindow {
        kind: WindowKind::Incognito,
        profile: None,
        url: None,
        frame: None,
    });
    assert_eq!(w.state.last_active_profile(), work);
    w.act(Action::OpenWindow {
        kind: WindowKind::LittleArdia,
        profile: Some(w.default_profile()),
        url: Some("a.com".into()),
        frame: None,
    });
    assert_eq!(w.state.last_active_profile(), work);
    assert_eq!(
        w.state.route_link("https://a.com/", &mail()).profile_id,
        work
    );
}

#[test]
fn closing_the_focused_window_hands_links_to_the_next_one() {
    let mut w = World::new();
    let first = w.open();
    let work = w
        .act(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .profile
        .unwrap();
    let second = w.open();
    w.act(Action::SwitchProfile {
        window: second.clone(),
        profile: work.clone(),
    });
    assert_eq!(w.state.last_active_profile(), work);
    w.act(Action::CloseWindow { window: second });
    assert_eq!(w.state.focus_order[0], first);
    assert_eq!(w.state.last_active_profile(), w.default_profile());
}

#[test]
fn air_traffic_rules_are_saved_to_their_own_document() {
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    let work = store
        .dispatch(Action::CreateProfile {
            name: "Work".into(),
            color: None,
            icon: None,
        })
        .unwrap()
        .profile
        .unwrap();
    store
        .dispatch(Action::SetAirTraffic {
            config: rules(&work, "g-x"),
        })
        .unwrap();
    assert!(store.flush(Duration::from_secs(5)));
    let saved: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(ardia_state::air_traffic::DOCUMENT)).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["rules"].as_array().map(Vec::len), Some(3));
    drop(store);
    let (again, _) = BrowserStore::open(DataDir::new(dir.path()), LoadOptions::default()).unwrap();
    assert_eq!(again.snapshot().air_traffic.rules.len(), 3);
}
