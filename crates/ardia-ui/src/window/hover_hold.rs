use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use crate::window::chrome::Chrome;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Holders {
    pub menu: bool,
    pub rename: bool,
    pub icon_picker: bool,
    pub downloads: bool,
    pub popover: bool,
    pub panel: bool,
    pub find: bool,
    pub history_menu: bool,
    pub extension_popup: bool,
}

impl Holders {
    pub fn hold_hover(&self) -> bool {
        self.menu
            || self.rename
            || self.icon_picker
            || self.downloads
            || self.popover
            || self.panel
            || self.find
            || self.history_menu
            || self.extension_popup
    }
}

thread_local! {
    static HELD: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
    static NATIVE_MENUS: Cell<usize> = const { Cell::new(0) };
}

pub fn native_menu_opened() {
    NATIVE_MENUS.with(|n| n.set(n.get() + 1));
}

pub fn native_menu_closed() {
    NATIVE_MENUS.with(|n| n.set(n.get().saturating_sub(1)));
}

pub fn native_menu_shown() -> bool {
    NATIVE_MENUS.with(Cell::get) > 0
}

pub fn holders_of(c: &Chrome) -> Holders {
    use ardia_state::windows::Popover;
    let window = c.window.id.as_str();
    let popover = c.window.chrome.popover.as_ref();
    Holders {
        menu: c.ui.menu.is_some(),
        rename: c.ui.rename.is_some(),
        icon_picker: crate::sidebar::icon_picker::is_open(window),
        downloads: c.window.chrome.downloads_open || matches!(popover, Some(Popover::Downloads)),
        popover: popover.is_some_and(|p| !matches!(p, Popover::Downloads | Popover::History)),
        panel: c.window.chrome.command_bar.open,
        find: c
            .state
            .tabs
            .values()
            .any(|tab| tab.window_id == c.window.id && tab.live.find.open),
        history_menu: matches!(popover, Some(Popover::History)),
        extension_popup: c.host.extension_popup(&c.window.id).is_some(),
    }
}

pub fn note(c: &Chrome) {
    let held = holders_of(c).hold_hover();
    HELD.with(|h| h.borrow_mut().insert(c.window.id.as_str().to_owned(), held));
}

pub fn set(window: &str, held: bool) {
    HELD.with(|h| h.borrow_mut().insert(window.to_owned(), held));
}

pub fn hover_held(window: &str) -> bool {
    native_menu_shown() || HELD.with(|h| h.borrow().get(window).copied().unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_owner_holds_hover() {
        assert!(!Holders::default().hold_hover());
        for holders in [
            Holders {
                menu: true,
                ..Default::default()
            },
            Holders {
                rename: true,
                ..Default::default()
            },
            Holders {
                icon_picker: true,
                ..Default::default()
            },
            Holders {
                downloads: true,
                ..Default::default()
            },
            Holders {
                popover: true,
                ..Default::default()
            },
            Holders {
                panel: true,
                ..Default::default()
            },
            Holders {
                find: true,
                ..Default::default()
            },
            Holders {
                history_menu: true,
                ..Default::default()
            },
            Holders {
                extension_popup: true,
                ..Default::default()
            },
        ] {
            assert!(holders.hold_hover());
        }
    }

    #[test]
    fn a_native_menu_holds_hover_in_every_window_until_it_closes() {
        set("w-hold-test", false);
        assert!(!hover_held("w-hold-test"));
        native_menu_opened();
        assert!(hover_held("w-hold-test"));
        native_menu_closed();
        assert!(!hover_held("w-hold-test"));
        set("w-hold-test", true);
        assert!(hover_held("w-hold-test"));
        set("w-hold-test", false);
    }
}
