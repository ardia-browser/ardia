mod common;

use ardia_state::actions::{Action, GroupPatch, NewTab, PageUpdate};
use ardia_state::ids::{GroupId, ProfileId, SplitId, TabId, WindowId};
use ardia_state::model::{Orientation, TabPin};
use ardia_state::settings::{AfterClosingTab, NewTabPosition, SettingsPatch};
use ardia_state::splits::{PaneDirection, SplitSide};
use ardia_state::state::BrowserState;
use ardia_state::windows::WindowKind;
use common::{World, check_invariants, reloaded};
use proptest::prelude::*;

#[derive(Clone, Debug)]
enum Op {
    OpenWindow(u8, bool),
    CloseWindow(u8),
    FocusWindow(u8),
    NewTab(u8, bool, Option<u8>, bool),
    Activate(u8),
    Close(Vec<u8>, bool),
    Reopen(Option<u8>),
    Move(u8, u8, u8),
    Pin(u8, u8),
    Navigate(u8),
    Commit(u8, bool),
    Sleep(u8),
    Duplicate(u8),
    Clear(u8),
    Undo(u8),
    Group(Vec<u8>),
    AddToGroup(u8, u8),
    Ungroup(u8),
    LeaveGroups(u8),
    CloseGroup(u8),
    PinGroup(u8, bool),
    Split(Vec<u8>, bool),
    MoveGroup(u8, Option<u8>, bool, Option<u8>),
    TileFolder(Vec<u8>, u8, Option<u8>),
    SplitPane(u8, u8),
    RemovePane(u8),
    Unsplit(u8),
    Swap(u8, u8),
    MovePane(u8, u8),
    FocusPane(u8, bool),
    Flip(u8),
    Resize(u8, u8),
    CreateProfile,
    SwitchProfile(u8, u8),
    DeleteProfile(u8),
    Settings(u8),
    Peek(u8),
    ClosePeek(u8),
    PromotePeek(u8),
    PromoteLittle(u8),
    Cycle(u8, bool),
    SelectAt(u8, Option<u8>),
    LastWindow,
}

fn op() -> impl Strategy<Value = Op> {
    let n = any::<u8>();
    prop_oneof![
        3 => (0u8..3, any::<bool>()).prop_map(|(k, url)| Op::OpenWindow(k, url)),
        1 => n.prop_map(Op::CloseWindow),
        1 => n.prop_map(Op::FocusWindow),
        8 => (n, any::<bool>(), proptest::option::of(n), any::<bool>()).prop_map(|(w, url, opener, bg)| Op::NewTab(w, url, opener, bg)),
        4 => n.prop_map(Op::Activate),
        4 => (proptest::collection::vec(n, 1..4), any::<bool>()).prop_map(|(t, last)| Op::Close(t, last)),
        2 => proptest::option::of(n).prop_map(Op::Reopen),
        2 => (n, n, n).prop_map(|(t, w, i)| Op::Move(t, w, i)),
        2 => (n, 0u8..3).prop_map(|(t, p)| Op::Pin(t, p)),
        2 => n.prop_map(Op::Navigate),
        2 => (n, any::<bool>()).prop_map(|(t, audible)| Op::Commit(t, audible)),
        1 => n.prop_map(Op::Sleep),
        1 => n.prop_map(Op::Duplicate),
        1 => n.prop_map(Op::Clear),
        1 => n.prop_map(Op::Undo),
        2 => proptest::collection::vec(n, 1..4).prop_map(Op::Group),
        1 => (n, n).prop_map(|(g, t)| Op::AddToGroup(g, t)),
        1 => n.prop_map(Op::Ungroup),
        1 => n.prop_map(Op::LeaveGroups),
        1 => n.prop_map(Op::CloseGroup),
        1 => (n, any::<bool>()).prop_map(|(g, on)| Op::PinGroup(g, on)),
        2 => (proptest::collection::vec(n, 2..5), any::<bool>()).prop_map(|(t, h)| Op::Split(t, h)),
        2 => (n, proptest::option::of(n), any::<bool>(), proptest::option::of(n)).prop_map(|(g, b, pin, parent)| Op::MoveGroup(g, b, pin, parent)),
        2 => (proptest::collection::vec(n, 1..3), n, proptest::option::of(n)).prop_map(|(t, onto, b)| Op::TileFolder(t, onto, b)),
        2 => (n, 0u8..4).prop_map(|(w, side)| Op::SplitPane(w, side)),
        1 => n.prop_map(Op::RemovePane),
        1 => n.prop_map(Op::Unsplit),
        1 => (n, n).prop_map(|(a, b)| Op::Swap(a, b)),
        1 => (n, 0u8..4).prop_map(|(t, d)| Op::MovePane(t, d)),
        1 => (n, any::<bool>()).prop_map(|(w, f)| Op::FocusPane(w, f)),
        1 => n.prop_map(Op::Flip),
        1 => (n, n).prop_map(|(s, r)| Op::Resize(s, r)),
        1 => Just(Op::CreateProfile),
        2 => (n, n).prop_map(|(w, p)| Op::SwitchProfile(w, p)),
        1 => n.prop_map(Op::DeleteProfile),
        1 => n.prop_map(Op::Settings),
        1 => n.prop_map(Op::Peek),
        1 => n.prop_map(Op::ClosePeek),
        1 => n.prop_map(Op::PromotePeek),
        1 => n.prop_map(Op::PromoteLittle),
        1 => (n, any::<bool>()).prop_map(|(w, f)| Op::Cycle(w, f)),
        1 => (n, proptest::option::of(n)).prop_map(|(w, i)| Op::SelectAt(w, i)),
        1 => Just(Op::LastWindow),
    ]
}

fn pick<T: Clone>(list: &[T], i: u8) -> Option<T> {
    (!list.is_empty()).then(|| list[usize::from(i) % list.len()].clone())
}

struct Pools {
    windows: Vec<WindowId>,
    tabs: Vec<TabId>,
    groups: Vec<GroupId>,
    splits: Vec<SplitId>,
    profiles: Vec<ProfileId>,
}

fn pools(s: &BrowserState) -> Pools {
    Pools {
        windows: s
            .window_order
            .iter()
            .chain(s.windows.keys())
            .fold(Vec::new(), |mut acc, w| {
                if !acc.contains(w) {
                    acc.push(w.clone());
                }
                acc
            }),
        tabs: s.tabs.keys().cloned().collect(),
        groups: s.groups.keys().cloned().collect(),
        splits: s.splits.keys().cloned().collect(),
        profiles: s.profile_order.iter().cloned().collect(),
    }
}

const SITES: [&str; 6] = [
    "a.com",
    "b.org",
    "c.dev",
    "search words",
    "localhost:8080/x",
    "https://d.io/path?q=1",
];

fn action(s: &BrowserState, op: &Op) -> Option<Action> {
    let p = pools(s);
    let tab = |i: &u8| pick(&p.tabs, *i);
    let window = |i: &u8| pick(&p.windows, *i);
    Some(match op {
        Op::OpenWindow(kind, url) => Action::OpenWindow {
            kind: [
                WindowKind::Main,
                WindowKind::Incognito,
                WindowKind::LittleArdia,
            ][usize::from(*kind)],
            profile: None,
            url: url.then(|| SITES[usize::from(*kind) % SITES.len()].to_owned()),
            frame: None,
        },
        Op::CloseWindow(w) => Action::CloseWindow { window: window(w)? },
        Op::FocusWindow(w) => Action::FocusWindow { window: window(w)? },
        Op::NewTab(w, url, opener, background) => Action::NewTab {
            window: window(w)?,
            tab: NewTab {
                url: url.then(|| SITES[usize::from(*w) % SITES.len()].to_owned()),
                opener: opener.as_ref().and_then(tab),
                background: *background,
                ..NewTab::default()
            },
        },
        Op::Activate(t) => Action::ActivateTab { tab: tab(t)? },
        Op::Close(ts, last) => Action::CloseTabs {
            tabs: ts.iter().filter_map(tab).collect(),
            last_closes_window: *last,
        },
        Op::Reopen(w) => Action::ReopenClosed {
            window: w.as_ref().and_then(window),
        },
        Op::Move(t, w, i) => Action::MoveTab {
            tab: tab(t)?,
            window: window(w)?,
            index: usize::from(*i) % 8,
        },
        Op::Pin(t, kind) => Action::SetPin {
            tab: tab(t)?,
            pin: [None, Some(TabPin::TILE), Some(TabPin::Row)][usize::from(*kind)].clone(),
        },
        Op::Navigate(t) => Action::Navigate {
            tab: tab(t)?,
            input: SITES[usize::from(*t) % SITES.len()].to_owned(),
        },
        Op::Commit(t, audible) => Action::UpdatePage {
            tab: tab(t)?,
            update: PageUpdate {
                url: Some(format!("https://commit{}.com/", t % 5)),
                title: Some(format!("Page {t}")),
                audible: Some(*audible),
                loading: Some(false),
                ..PageUpdate::default()
            },
        },
        Op::Sleep(t) => Action::SleepTabs {
            tabs: vec![tab(t)?],
        },
        Op::Duplicate(t) => Action::DuplicateTab { tab: tab(t)? },
        Op::Clear(w) => Action::ClearUnpinned { window: window(w)? },
        Op::Undo(w) => Action::UndoClear { window: window(w)? },
        Op::Group(ts) => Action::CreateGroup {
            tabs: ts.iter().filter_map(tab).collect(),
            name: "G".into(),
        },
        Op::MoveGroup(g, before, pinned, parent) => Action::MoveGroup {
            group: pick(&p.groups, *g)?,
            before: before.as_ref().and_then(tab),
            pinned: *pinned,
            parent: parent.and_then(|i| pick(&p.groups, i)),
        },
        Op::TileFolder(ts, onto, before) => Action::AddToTileFolder {
            tabs: ts.iter().filter_map(tab).collect(),
            onto: tab(onto)?,
            before: before.as_ref().and_then(tab),
        },
        Op::AddToGroup(g, t) => Action::AddToGroup {
            group: pick(&p.groups, *g)?,
            tabs: vec![tab(t)?],
        },
        Op::Ungroup(g) => Action::Ungroup {
            group: pick(&p.groups, *g)?,
        },
        Op::LeaveGroups(t) => Action::RemoveFromGroups {
            tabs: vec![tab(t)?],
        },
        Op::CloseGroup(g) => Action::CloseGroup {
            group: pick(&p.groups, *g)?,
        },
        Op::PinGroup(g, on) => Action::UpdateGroup {
            group: pick(&p.groups, *g)?,
            patch: GroupPatch {
                pinned: Some(*on),
                collapsed: Some(!*on),
                ..GroupPatch::default()
            },
        },
        Op::Split(ts, horizontal) => Action::SplitTabs {
            tabs: ts.iter().filter_map(tab).collect(),
            orientation: if *horizontal {
                Orientation::Horizontal
            } else {
                Orientation::Vertical
            },
        },
        Op::SplitPane(w, side) => Action::OpenSplitPane {
            window: window(w)?,
            side: SplitSide::ALL[usize::from(*side)],
            url: Some("pane.com".into()),
        },
        Op::RemovePane(t) => Action::RemoveFromSplit { tab: tab(t)? },
        Op::Unsplit(sp) => Action::Unsplit {
            split: pick(&p.splits, *sp)?,
        },
        Op::Swap(a, b) => Action::SwapPanes {
            a: tab(a)?,
            b: tab(b)?,
        },
        Op::MovePane(t, d) => Action::MovePane {
            tab: tab(t)?,
            direction: PaneDirection::ALL[usize::from(*d)],
        },
        Op::FocusPane(w, forward) => Action::FocusPane {
            window: window(w)?,
            delta: if *forward { 1 } else { -1 },
        },
        Op::Flip(sp) => Action::FlipSplit {
            split: pick(&p.splits, *sp)?,
        },
        Op::Resize(sp, r) => {
            let split = pick(&p.splits, *sp)?;
            let slots = s.splits[&split].slots.len();
            Action::ResizeSplit {
                split,
                sizes: (0..slots)
                    .map(|i| 1.0 + f64::from(*r % 7) * i as f64)
                    .collect(),
            }
        }
        Op::CreateProfile => Action::CreateProfile {
            name: format!("P{}", p.profiles.len()),
            color: None,
            icon: None,
        },
        Op::SwitchProfile(w, pr) => Action::SwitchProfile {
            window: window(w)?,
            profile: pick(&p.profiles, *pr)?,
        },
        Op::DeleteProfile(pr) => Action::DeleteProfile {
            profile: pick(&p.profiles, *pr)?,
        },
        Op::Settings(k) => Action::UpdateSettings {
            patch: match k % 5 {
                0 => SettingsPatch::new()
                    .set("newTabPosition", NewTabPosition::ALL[usize::from(*k) % 3]),
                1 => SettingsPatch::new()
                    .set("afterClosingTab", AfterClosingTab::ALL[usize::from(*k) % 3]),
                2 => SettingsPatch::new().set("autoHideTabs", k % 10 < 5),
                3 => SettingsPatch::new().set("keepTopAppsRunning", k % 10 < 5),
                _ => SettingsPatch::new().set("restoreSession", k % 10 < 5),
            },
            from_sync: k % 7 == 0,
        },
        Op::Peek(w) => Action::OpenPeek {
            window: window(w)?,
            url: "peek.com".into(),
            source: (w % 3 == 0).then(|| tab(w)).flatten(),
        },
        Op::ClosePeek(w) => Action::ClosePeek { window: window(w)? },
        Op::PromotePeek(w) => Action::PromotePeek { window: window(w)? },
        Op::PromoteLittle(w) => Action::PromoteLittleArdia { window: window(w)? },
        Op::Cycle(w, forward) => Action::CycleTab {
            window: window(w)?,
            delta: if *forward { 1 } else { -1 },
        },
        Op::SelectAt(w, i) => Action::SelectTabAt {
            window: window(w)?,
            index: i.map(usize::from),
        },
        Op::LastWindow => Action::OpenLastWindowOrNew,
    })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("ARDIA_STATE_CASES").ok().and_then(|n| n.parse().ok()).unwrap_or(400), max_shrink_iters: 4000, ..ProptestConfig::default() })]

    #[test]
    fn any_sequence_of_actions_keeps_the_state_consistent(ops in proptest::collection::vec(op(), 1..90)) {
        let mut w = World::new();
        w.open();
        for op in &ops {
            let Some(action) = action(&w.state, op) else { continue };
            let before = w.state.session_json();
            let shown = format!("{action:?}");
            match w.try_act(action) {
                Ok(_) => check_invariants(&w.state),
                Err(_) => prop_assert_eq!(&w.state.session_json(), &before, "{} failed but changed the state", shown),
            }
        }
        let once = reloaded(&w.state, w.now + 1);
        check_invariants(&once);
        let twice = reloaded(&once, w.now + 2);
        prop_assert_eq!(once.session_json(), twice.session_json());
    }
}

fn replay(ops: &[Op]) {
    let mut w = World::new();
    w.open();
    for op in ops {
        let Some(action) = action(&w.state, op) else {
            continue;
        };
        if w.try_act(action).is_ok() {
            check_invariants(&w.state);
        }
    }
}

#[test]
fn unpinning_a_mirrored_tab_keeps_a_split_in_another_window_together() {
    use Op::*;
    replay(&[
        Activate(0),
        NewTab(0, false, None, false),
        Duplicate(0),
        Pin(3, 2),
        NewTab(0, false, None, false),
        NewTab(0, false, None, false),
        Duplicate(0),
        SplitPane(0, 0),
        OpenWindow(1, false),
        NewTab(2, false, None, false),
        OpenWindow(0, false),
        Split(vec![99, 192, 35], false),
        Move(2, 11, 104),
        Pin(251, 1),
        SplitPane(53, 0),
        Split(vec![15, 196, 70], false),
        Close(vec![18], false),
        OpenWindow(1, false),
        Swap(0, 0),
        RemovePane(6),
        NewTab(11, false, None, false),
        NewTab(19, false, None, false),
        NewTab(19, false, None, false),
        Peek(82),
        Clear(70),
        Pin(111, 0),
    ]);
}

#[test]
fn unpinning_a_mirrored_tab_hands_a_hidden_profile_its_next_tab() {
    use Op::*;
    replay(&[
        CreateProfile,
        OpenWindow(0, true),
        NewTab(103, false, None, false),
        Close(vec![3], false),
        NewTab(0, false, None, false),
        Pin(236, 1),
        Activate(4),
        Activate(89),
        SwitchProfile(8, 5),
        Pin(30, 0),
    ]);
}
