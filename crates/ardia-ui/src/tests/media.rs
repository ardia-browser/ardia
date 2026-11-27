use ardia_state::Action;
use ardia_state::model::TabPin;
use gpui::TestAppContext;

use crate::UiHost;
use crate::media::session::{MediaAction, NowPlaying};
use crate::mock::HostCall;
use crate::tests::support::Browser;

fn playing() -> NowPlaying {
    NowPlaying::sanitized(&serde_json::json!({
        "title": "A Song",
        "artist": "A Band",
        "playbackState": "playing",
        "position": 30.0,
        "duration": 240.0,
        "playbackRate": 1.0,
        "timestamp": crate::media::mini_player::now_ms(),
        "actions": ["play", "pause"],
        "controllable": true,
    }))
    .expect("a report")
}

#[gpui::test]
fn leaving_a_playing_tab_shows_the_sidebar_player_and_going_back_ends_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let music = browser.new_tab(cx, "https://music.example.com/play");
    browser.act(cx, Action::ActivateTab { tab: music.clone() });
    browser
        .host
        .set_now_playing(&music, Some(playing()), crate::media::mini_player::now_ms());
    browser.redraw(cx);
    assert!(
        browser.bounds(cx, "sidebar-player").is_none(),
        "no player for the shown tab"
    );

    browser.act(cx, Action::ActivateTab { tab: first });
    browser.redraw(cx);
    assert!(
        browser.bounds(cx, "sidebar-player").is_some(),
        "the hidden playing tab gets a player"
    );

    browser.click(cx, "sidebar-player-row");
    assert_eq!(browser.active(), music, "the row goes back to the tab");
    browser.redraw(cx);
    assert!(
        browser.bounds(cx, "sidebar-player").is_none(),
        "going back ends the player"
    );
    assert!(
        !browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::MediaAction { .. })),
        "going back never touches playback"
    );
}

#[gpui::test]
fn dismissing_the_player_hides_it_without_pausing(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let music = browser.new_tab(cx, "https://music.example.com/play");
    browser.act(cx, Action::ActivateTab { tab: music.clone() });
    browser
        .host
        .set_now_playing(&music, Some(playing()), crate::media::mini_player::now_ms());
    browser.act(cx, Action::ActivateTab { tab: first });
    browser.redraw(cx);
    assert!(browser.bounds(cx, "sidebar-player").is_some());

    browser.host.dismiss_player(music.clone());
    browser.redraw(cx);
    assert!(browser.bounds(cx, "sidebar-player").is_none());
    assert!(
        browser
            .host
            .media_session(&music)
            .is_some_and(|s| s.now.is_playing())
    );
    assert!(
        !browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::MediaAction { .. })),
        "dismissing never pauses"
    );
}

#[gpui::test]
fn a_tab_left_paused_gets_no_player(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let first = browser.active();
    let music = browser.new_tab(cx, "https://music.example.com/play");
    browser.act(cx, Action::ActivateTab { tab: music.clone() });
    let now = crate::media::mini_player::now_ms();
    browser.host.set_now_playing(&music, Some(playing()), now);
    let mut paused = playing();
    paused.playback = crate::media::session::Playback::Paused;
    browser.host.set_now_playing(&music, Some(paused), now);
    browser.act(cx, Action::ActivateTab { tab: first });
    browser.redraw(cx);
    assert!(browser.bounds(cx, "sidebar-player").is_none());
}

#[gpui::test]
fn only_pinned_tabs_with_media_controls_get_the_mini_player(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let music = browser.new_tab(cx, "https://music.example.com/play");
    browser
        .host
        .set_now_playing(&music, Some(playing()), crate::media::mini_player::now_ms());
    assert!(!browser.host.shows_mini_player(&music));
    browser.act(
        cx,
        Action::SetPin {
            tab: music.clone(),
            pin: Some(TabPin::TILE),
        },
    );
    assert!(browser.host.shows_mini_player(&music));
    browser
        .host
        .media_action(music.clone(), MediaAction::Toggle);
    assert!(browser.host.calls().contains(&HostCall::MediaAction {
        tab: music,
        action: MediaAction::Toggle,
    }));
}

fn display_request() -> crate::media::share::DisplayRequest {
    crate::media::share::DisplayRequest {
        id: "req-1".into(),
        origin: "https://meet.example".into(),
        frame_origin: "https://meet.example".into(),
        audio: Some(crate::media::share::AudioOffer {
            tab: true,
            screen: false,
            window: None,
        }),
        controller: false,
    }
}

#[gpui::test]
fn a_page_asking_to_share_shows_the_picker_and_cancel_refuses(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.host.set_display_request(&tab, display_request());
    browser.redraw(cx);
    assert!(browser.bounds(cx, "share-picker").is_some());
    browser.click(cx, "share-cancel");
    assert!(browser.host.calls().contains(&HostCall::AnswerDisplay {
        tab,
        source: None,
        audio: false,
    }));
    browser.redraw(cx);
    assert!(browser.bounds(cx, "share-picker").is_none());
}

#[gpui::test]
fn a_shared_tab_shows_the_share_bar_until_dismissed(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    let capturer = browser.new_tab(cx, "https://meet.example/room");
    browser.act(cx, Action::ActivateTab { tab: tab.clone() });
    browser.host.set_share_bar(
        &tab,
        &capturer,
        crate::media::share::TabShare {
            captured: tab.clone(),
            origin: "https://meet.example".into(),
            dismissed: Default::default(),
        },
    );
    for _ in 0..3 {
        browser.redraw(cx);
    }
    assert!(browser.bounds(cx, "share-bar").is_some());
    browser.host.dismiss_share_bar(capturer, tab);
    browser.redraw(cx);
    std::thread::sleep(std::time::Duration::from_millis(200));
    browser.redraw(cx);
    assert!(browser.bounds(cx, "share-bar").is_none());
}

#[gpui::test]
fn escape_refuses_the_share_request(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.host.set_display_request(&tab, display_request());
    browser.redraw(cx);
    assert!(browser.bounds(cx, "share-picker").is_some());
    browser.keys(cx, "escape");
    assert!(browser.host.calls().contains(&HostCall::AnswerDisplay {
        tab,
        source: None,
        audio: false,
    }));
}

#[gpui::test]
fn enter_shares_this_tab_which_is_picked_first(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let tab = browser.active();
    browser.act(
        cx,
        Action::UpdatePage {
            tab: tab.clone(),
            update: ardia_state::PageUpdate {
                url: Some("https://example.com/docs/start".into()),
                ..Default::default()
            },
        },
    );
    browser.host.set_display_request(&tab, display_request());
    browser.redraw(cx);
    browser.keys(cx, "enter");
    assert!(
        browser
            .host
            .calls()
            .iter()
            .any(|call| matches!(call, HostCall::ShareTabWith { shared, .. } if *shared == tab))
    );
}

#[gpui::test]
fn a_crx_dropped_on_the_window_installs_it(cx: &mut TestAppContext) {
    let browser = Browser::open(cx);
    let mut visual = gpui::VisualTestContext::from_window(browser.handle.into(), cx);
    let at = gpui::point(gpui::px(600.), gpui::px(400.));
    let paths = gpui::ExternalPaths(smallvec::smallvec![std::path::PathBuf::from(
        "/tmp/blocker.crx"
    )]);
    visual.simulate_event(gpui::FileDropEvent::Entered {
        position: at,
        paths,
    });
    visual.simulate_event(gpui::FileDropEvent::Pending { position: at });
    visual.simulate_event(gpui::FileDropEvent::Submit { position: at });
    visual.run_until_parked();
    assert!(browser.host.calls().iter().any(|call| matches!(
        call,
        HostCall::InstallCrx { path, .. } if path == "/tmp/blocker.crx"
    )));
}
