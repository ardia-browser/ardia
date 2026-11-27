use ardia_state::BrowserState;
use ardia_state::actions::Action;

use crate::coordinator::AppCoordinator;

pub fn front_window_edits_text(state: &BrowserState) -> bool {
    let Some(front) = state
        .focus_order
        .first()
        .and_then(|id| state.window(id.as_str()))
    else {
        return false;
    };
    if !front.kind.has_tabs() {
        return true;
    }
    front.chrome.command_bar.open
        || state
            .active_tab(front.id.as_str())
            .is_some_and(|t| t.live.find.open)
}

pub fn undo_reopens_closed_tab(
    state: &BrowserState,
    page_edits_text: bool,
    can_reopen: bool,
) -> bool {
    state.settings.undo_reopens_closed_tab
        && can_reopen
        && !page_edits_text
        && !front_window_edits_text(state)
        && crate::menu_bridge::focused_window(state).is_some()
}

#[cfg(target_os = "macos")]
pub fn key_responder_edits_text() -> bool {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel};

    unsafe {
        let app: Option<Retained<AnyObject>> = msg_send![class!(NSApplication), sharedApplication];
        let Some(app) = app else {
            return false;
        };
        let window: Option<Retained<AnyObject>> = msg_send![&*app, keyWindow];
        let Some(window) = window else {
            return false;
        };
        let responder: Option<Retained<AnyObject>> = msg_send![&*window, firstResponder];
        let Some(responder) = responder else {
            return false;
        };
        let is_text: Bool = msg_send![&*responder, isKindOfClass: class!(NSText)];
        if is_text.as_bool() {
            return true;
        }
        let answers: Bool = msg_send![&*responder, respondsToSelector: sel!(textInputType)];
        if !answers.as_bool() {
            return false;
        }
        let kind: i32 = msg_send![&*responder, textInputType];
        kind != 0
    }
}

#[cfg(not(target_os = "macos"))]
pub fn key_responder_edits_text() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn forward_undo() {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, sel};

    unsafe {
        let app: Option<Retained<AnyObject>> = msg_send![class!(NSApplication), sharedApplication];
        if let Some(app) = app {
            let nothing: *const AnyObject = std::ptr::null();
            let _: Bool = msg_send![&*app, sendAction: sel!(undo:), to: nothing, from: nothing];
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn forward_undo() {}

impl AppCoordinator {
    pub fn undo_or_reopen_closed_tab(&self) {
        let state = self.store().snapshot();
        let can_reopen = self.command_enabled("reopenClosedTab", None);
        if undo_reopens_closed_tab(&state, key_responder_edits_text(), can_reopen) {
            let window = crate::menu_bridge::focused_window(&state);
            if let Err(problem) = self.dispatch_action(Action::ReopenClosed { window }) {
                log::debug!("undo found no closed tab to reopen: {problem}");
            }
            return;
        }
        forward_undo();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::ids::IdGen;
    use ardia_state::persistence::session::{LoadOptions, SessionData};
    use ardia_state::settings::SettingsPatch;
    use ardia_state::windows::WindowKind;

    fn act(state: &mut BrowserState, ids: &IdGen, action: Action) {
        state.apply(action, 2, ids).expect("action");
    }

    fn browser() -> (BrowserState, IdGen) {
        let ids = IdGen::with_launch("undo");
        let mut state = BrowserState::from_session(SessionData::fresh(LoadOptions::default()), 1);
        act(
            &mut state,
            &ids,
            Action::OpenWindow {
                kind: WindowKind::Main,
                profile: None,
                url: Some("https://a.example".into()),
                frame: None,
            },
        );
        (state, ids)
    }

    #[test]
    fn undo_reopens_a_tab_only_when_asked_and_nothing_edits_text() {
        let (mut state, ids) = browser();
        assert!(!undo_reopens_closed_tab(&state, false, true));
        act(
            &mut state,
            &ids,
            Action::UpdateSettings {
                patch: SettingsPatch::new().set("undoReopensClosedTab", true),
                from_sync: false,
            },
        );
        assert!(undo_reopens_closed_tab(&state, false, true));
        assert!(!undo_reopens_closed_tab(&state, true, true));
        assert!(!undo_reopens_closed_tab(&state, false, false));
        let window = state.window_order[0].clone();
        act(
            &mut state,
            &ids,
            Action::SetCommandBar {
                window,
                state: ardia_state::windows::CommandBarState {
                    open: true,
                    ..Default::default()
                },
            },
        );
        assert!(!undo_reopens_closed_tab(&state, false, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_undo_item_runs_through_ardia_when_it_reopens_tabs() {
        use ardia_engine::macos::menu::{MenuContext, MenuItem};
        fn find(items: &[MenuItem]) -> Option<&MenuItem> {
            items.iter().find_map(|item| match item {
                MenuItem::Command(c) if c.command == "undo" => Some(item),
                MenuItem::Standard(s) if s.action == "undo:" => Some(item),
                MenuItem::Submenu(menu) => find(&menu.items),
                _ => None,
            })
        }
        let mut bar = crate::menu_bridge::native::menu_bar(&MenuContext {
            app_name: "Ardia".into(),
            ..MenuContext::default()
        });
        let undo = |bar: &ardia_engine::macos::menu::MenuBar| {
            bar.menus.iter().find_map(|m| find(&m.items)).cloned()
        };
        assert!(matches!(undo(&bar), Some(MenuItem::Standard(_))));
        crate::menu_bridge::native::route_undo(&mut bar);
        match undo(&bar) {
            Some(MenuItem::Command(command)) => {
                assert_eq!(command.title, "Undo");
                assert!(command.shortcut.is_some());
            }
            other => panic!("undo stayed {other:?}"),
        }
    }
}
