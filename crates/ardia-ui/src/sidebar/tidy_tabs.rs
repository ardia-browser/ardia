use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use ardia_state::tidy::{
    Tidied, TidyScope, can_undo_tidy, tidied_detail, tidied_in, tidied_message, tidy_plan_in,
};
use ardia_state::windows::ToastKind;
use ardia_state::{Action, BrowserState, ProfileId, WindowId};
use base64::Engine;

use crate::msg::Msg;

pub const TIDY_COMMAND: &str = "tidyTabs";
pub const TIDY_PINS_COMMAND: &str = "tidyPins";
pub const UNDO_TIDY_PREFIX: &str = "undoTidyTabs:";
pub const TIDY_SYMBOL: &str = "sparkles";
pub const BROOM_SIZE: f32 = 11.0;
const KEPT_RECORDS: u64 = 8;

thread_local! {
    static RECORDS: RefCell<(u64, HashMap<u64, Tidied>)> = RefCell::new((0, HashMap::new()));
}

static BROOM: LazyLock<Arc<[u8]>> = LazyLock::new(|| {
    let data = base64::engine::general_purpose::STANDARD
        .encode(include_bytes!("../../assets/sidebar/tidy-broom.png"));
    Arc::from(
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 33 33\"><image width=\"33\" height=\"33\" xlink:href=\"data:image/png;base64,{data}\"/></svg>"
        )
        .into_bytes(),
    )
});

pub fn broom_mask() -> Arc<[u8]> {
    Arc::clone(&BROOM)
}

pub fn offers_tidy(state: &BrowserState, window: &str, profile: &ProfileId) -> bool {
    state.settings.tidy_tabs && ardia_state::tidy::offers_tidy_tabs(state, window, Some(profile))
}

fn remember(tidied: Tidied) -> u64 {
    RECORDS.with(|records| {
        let mut records = records.borrow_mut();
        records.0 += 1;
        let id = records.0;
        records.1.insert(id, tidied);
        records.1.retain(|kept, _| *kept + KEPT_RECORDS > id);
        id
    })
}

fn recalled(id: u64) -> Option<Tidied> {
    RECORDS.with(|records| records.borrow().1.get(&id).cloned())
}

pub fn tidy_messages(state: &BrowserState, window: &WindowId, profile: &ProfileId) -> Vec<Msg> {
    scoped_messages(state, window, Some(profile), TidyScope::Tabs)
}

pub fn tidy_pins_messages(state: &BrowserState, window: &WindowId) -> Vec<Msg> {
    scoped_messages(state, window, None, TidyScope::Pins)
}

pub fn toast_message(tidied: &Tidied) -> String {
    let title = tidied_message(tidied);
    match tidied_detail(tidied) {
        Some(detail) => format!("{title}\n{detail}"),
        None => title,
    }
}

pub fn can_undo(state: &BrowserState, arg: &str) -> bool {
    arg.parse::<u64>()
        .ok()
        .and_then(recalled)
        .is_some_and(|tidied| can_undo_tidy(state, &tidied))
}

fn scoped_messages(
    state: &BrowserState,
    window: &WindowId,
    profile: Option<&ProfileId>,
    scope: TidyScope,
) -> Vec<Msg> {
    let Some(plan) = tidy_plan_in(state, window.as_str(), profile, scope) else {
        return Vec::new();
    };
    let Some(tidied) = tidied_in(state, window.as_str(), &plan, scope) else {
        return Vec::new();
    };
    if scope == TidyScope::Tabs {
        ardia_telemetry::counts::count("tidy_tabs_runs");
        ardia_telemetry::counts::add("tidy_tabs_moved", tidied.moved.len() as u64);
    }
    let message = toast_message(&tidied);
    let action = match scope {
        TidyScope::Tabs => Action::TidyTabs {
            window: window.clone(),
            profile: profile.cloned(),
        },
        TidyScope::Pins => Action::TidyPins {
            window: window.clone(),
        },
    };
    let undo = format!("{UNDO_TIDY_PREFIX}{}", remember(tidied));
    let mut toast = crate::popovers::toast::toast(
        message,
        ToastKind::Undo,
        Some(&undo),
        ardia_state::store::now_ms(),
    );
    toast.icon = Some(TIDY_SYMBOL.to_owned());
    vec![
        Msg::Store(action),
        Msg::Store(Action::PushToast {
            window: window.clone(),
            toast,
        }),
    ]
}

pub fn undo_messages(state: &BrowserState, arg: &str) -> Vec<Msg> {
    let Some(tidied) = arg.parse::<u64>().ok().and_then(recalled) else {
        return Vec::new();
    };
    if !can_undo_tidy(state, &tidied) {
        return Vec::new();
    }
    if tidied.scope == TidyScope::Tabs {
        ardia_telemetry::counts::count("tidy_tabs_undos");
    }
    vec![Msg::Store(Action::UntidyTabs { tidied })]
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::actions::NewTab;
    use ardia_state::ids::IdGen;
    use ardia_state::store::BrowserStore;
    use ardia_state::windows::WindowKind;

    fn apply(store: &BrowserStore, msgs: Vec<Msg>) {
        for msg in msgs {
            if let Msg::Store(action) = msg {
                store.dispatch(action).ok();
            }
        }
    }

    #[test]
    fn tidy_toasts_the_old_copy_and_undoes_from_its_record() {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("u"));
        store
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            })
            .ok();
        let window = store
            .read(|s| s.windows.keys().next().cloned())
            .expect("a window");
        for url in [
            "https://github.com/a",
            "https://a.com/",
            "https://github.com/b",
        ] {
            store
                .dispatch(Action::NewTab {
                    window: window.clone(),
                    tab: NewTab {
                        url: Some(url.to_owned()),
                        background: true,
                        ..NewTab::default()
                    },
                })
                .ok();
        }
        let profile = store.read(|s| s.windows[&window].profile_id.clone());
        let before = store.read(|s| s.windows[&window].tab_ids.clone());
        let msgs = tidy_messages(&store.snapshot(), &window, &profile);
        let toast = msgs.iter().find_map(|m| match m {
            Msg::Store(Action::PushToast { toast, .. }) => Some(toast.clone()),
            _ => None,
        });
        let toast = toast.expect("a toast");
        assert_eq!(toast.message, "Tidied 2 Tabs into 1 Group");
        assert_eq!(toast.icon.as_deref(), Some(TIDY_SYMBOL));
        assert_eq!(toast.kind, ToastKind::Undo);
        apply(&store, msgs);
        assert_eq!(store.read(|s| s.groups.len()), 1);
        let arg = toast
            .action
            .as_deref()
            .and_then(|a| a.strip_prefix(UNDO_TIDY_PREFIX))
            .expect("an undo");
        apply(&store, undo_messages(&store.snapshot(), arg));
        assert_eq!(store.read(|s| s.groups.len()), 0);
        assert_eq!(store.read(|s| s.windows[&window].tab_ids.clone()), before);
        assert!(tidy_messages(&store.snapshot(), &window, &ProfileId::new("none")).is_empty());
    }

    #[test]
    fn the_broom_is_an_image_mask() {
        let svg = String::from_utf8(broom_mask().to_vec()).unwrap_or_default();
        assert!(svg.contains("data:image/png;base64,"));
    }

    fn window_with(store: &BrowserStore, urls: &[&str]) -> (WindowId, Vec<ardia_state::TabId>) {
        store
            .dispatch(Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: None,
                frame: None,
            })
            .ok();
        let window = store
            .read(|s| s.windows.keys().next().cloned())
            .expect("a window");
        let ids = urls
            .iter()
            .filter_map(|url| {
                store
                    .dispatch(Action::NewTab {
                        window: window.clone(),
                        tab: NewTab {
                            url: Some((*url).to_owned()),
                            background: true,
                            ..NewTab::default()
                        },
                    })
                    .ok()
                    .and_then(|o| o.tab)
            })
            .collect();
        (window, ids)
    }

    #[test]
    fn tidy_pins_toasts_folders_and_duplicates() {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("p"));
        let (window, ids) = window_with(
            &store,
            &[
                "https://github.com/a",
                "https://github.com/b",
                "https://github.com/a",
            ],
        );
        for id in &ids {
            store
                .dispatch(Action::SetPin {
                    tab: id.clone(),
                    pin: Some(ardia_state::model::TabPin::Row),
                })
                .ok();
        }
        let msgs = tidy_pins_messages(&store.snapshot(), &window);
        let toast = msgs
            .iter()
            .find_map(|m| match m {
                Msg::Store(Action::PushToast { toast, .. }) => Some(toast.clone()),
                _ => None,
            })
            .expect("a toast");
        assert_eq!(
            toast.message,
            "Tidied 2 Pins into 1 Folder\nClosed 1 duplicate"
        );
        apply(&store, msgs);
        assert!(store.read(|s| s.groups.values().all(|g| g.pinned)));
        assert_eq!(store.read(|s| s.groups.len()), 1);
    }

    #[test]
    fn the_undo_toast_leaves_once_undo_is_no_longer_possible() {
        let store = BrowserStore::in_memory(BrowserState::default(), IdGen::with_launch("w"));
        let (window, ids) = window_with(
            &store,
            &[
                "https://github.com/a",
                "https://a.com/",
                "https://github.com/b",
            ],
        );
        let profile = store.read(|s| s.windows[&window].profile_id.clone());
        let msgs = tidy_messages(&store.snapshot(), &window, &profile);
        let toast = msgs
            .iter()
            .find_map(|m| match m {
                Msg::Store(Action::PushToast { toast, .. }) => Some(toast.clone()),
                _ => None,
            })
            .expect("a toast");
        apply(&store, msgs);
        let shown = |store: &BrowserStore| {
            crate::popovers::toast::still_shown(&store.snapshot(), &window, &toast)
        };
        assert!(shown(&store));
        store
            .dispatch(Action::SetPin {
                tab: ids[0].clone(),
                pin: Some(ardia_state::model::TabPin::Row),
            })
            .ok();
        assert!(!shown(&store));
        store
            .dispatch(Action::SetPin {
                tab: ids[0].clone(),
                pin: None,
            })
            .ok();
        assert!(!shown(&store), "a withdrawn toast stays gone");
    }
}
