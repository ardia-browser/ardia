use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use ardia_state::actions::GroupPatch;
use ardia_state::{Action, BrowserState, GroupId, TabId};
use gpui::{
    AnyElement, Context, Entity, IntoElement, MouseButton, SharedString, Styled, Subscription,
    Window, div, prelude::*,
};

use crate::icon_picker::{
    Anchor, IconPickerEvent, IconPickerView, PickerAction, PickerPlace, PickerSetup, PickerSymbol,
    Room, clamp_left, clamp_top, tokens,
};
use crate::window::browser_window::BrowserWindowView;
use crate::window::chrome::Chrome;

pub const NO_ROW_ICON: &str = "symbol:ardia:no-icon";
pub const DEFAULT_ANCHOR_Y: f32 = 60.0;

macro_rules! symbols {
    ($($name:literal),* $(,)?) => {
        &[$(PickerSymbol::new($name, "")),*]
    };
}

pub const SIDEBAR_SYMBOLS: &[PickerSymbol] = symbols![
    "star",
    "heart",
    "bookmark",
    "flag",
    "pin",
    "bolt",
    "flame",
    "leaf",
    "globe",
    "house",
    "briefcase",
    "cart",
    "bag",
    "creditcard",
    "dollarsign.circle",
    "chart.bar",
    "chart.line.uptrend.xyaxis",
    "calendar",
    "clock",
    "alarm",
    "envelope",
    "bubble.left",
    "phone",
    "video",
    "music.note",
    "headphones",
    "gamecontroller",
    "paintbrush",
    "camera",
    "film",
    "tv",
    "airplane",
    "map",
    "car",
    "fork.knife",
    "cup.and.saucer",
    "figure.run",
    "sportscourt",
    "pawprint",
    "tree",
    "sun.max",
    "moon",
    "cloud",
    "snowflake",
    "sparkles",
    "gift",
    "trophy",
    "target",
    "brain",
    "eye",
    "laptopcomputer",
    "desktopcomputer",
    "keyboard",
    "hammer",
    "wrench.and.screwdriver",
    "gearshape",
    "testtube.2",
    "ant",
    "lock",
    "key",
    "puzzlepiece",
    "shippingbox",
    "folder",
    "archivebox",
    "newspaper",
    "link",
    "magnifyingglass",
    "safari",
    "tag",
    "lightbulb",
    "questionmark.circle",
    "exclamationmark.triangle",
    "book",
    "graduationcap",
    "doc.text",
    "list.bullet",
    "checkmark.circle",
    "person.2",
];

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Tab(TabId),
    Group(GroupId),
}

struct Open {
    target: Target,
    view: Entity<IconPickerView>,
    _events: Subscription,
}

thread_local! {
    static OPEN: RefCell<HashMap<String, Open>> = RefCell::new(HashMap::new());
}

pub fn current_icon(state: &BrowserState, target: &Target) -> Option<String> {
    match target {
        Target::Tab(tab) => state.tab(tab.as_str()).and_then(|t| t.custom_icon.clone()),
        Target::Group(group) => state
            .groups
            .get(group)
            .and_then(|g| g.icon.clone())
            .filter(|icon| !icon.is_empty()),
    }
}

pub fn pinned_row(state: &BrowserState, target: &Target) -> bool {
    match target {
        Target::Tab(tab) => state
            .tab(tab.as_str())
            .is_some_and(|t| t.pin.as_ref().is_some_and(|pin| !pin.is_tile())),
        Target::Group(_) => false,
    }
}

pub fn actions(row: bool, current: Option<&str>) -> Vec<PickerAction> {
    let mut out = Vec::new();
    if row {
        out.push(PickerAction {
            title: SharedString::new_static("No Icon"),
            icon: Some("textformat"),
            primary: current == Some(NO_ROW_ICON),
            choice: Some(NO_ROW_ICON.to_owned()),
        });
    }
    if current.is_some() {
        out.push(PickerAction {
            title: SharedString::new_static("Reset Icon"),
            icon: None,
            primary: false,
            choice: None,
        });
    }
    out
}

pub fn beside_sidebar(
    anchor: Option<Anchor>,
    sidebar_width: f32,
    trailing: bool,
    room_width: f32,
) -> f32 {
    let gap = tokens::SIDEBAR_GAP;
    if trailing {
        let edge = room_width - sidebar_width - gap;
        anchor.map_or(edge, |a| edge.max(a.x - gap)) - tokens::WIDTH
    } else {
        anchor.map_or(sidebar_width + gap, |a| {
            (sidebar_width + gap).min(a.x + a.width + gap)
        })
    }
}

pub fn place(
    anchor: Option<Anchor>,
    sidebar_width: f32,
    trailing: bool,
    height: f32,
    room: Room,
) -> PickerPlace {
    let top = clamp_top(
        anchor.map_or(DEFAULT_ANCHOR_Y, |a| a.y) - tokens::WINDOW_MARGIN,
        height,
        room,
    );
    let left = beside_sidebar(anchor, sidebar_width, trailing, room.width);
    PickerPlace {
        top,
        left: if anchor.is_some() {
            clamp_left(left, room)
        } else {
            left
        },
        upward: false,
    }
}

fn choice_action(target: &Target, icon: Option<String>) -> Action {
    match target {
        Target::Tab(tab) => Action::SetTabIcon {
            tab: tab.clone(),
            icon,
        },
        Target::Group(group) => Action::UpdateGroup {
            group: group.clone(),
            patch: GroupPatch {
                icon: Some(icon),
                ..GroupPatch::default()
            },
        },
    }
}

pub fn open(
    view: &BrowserWindowView,
    target: Target,
    window: &mut Window,
    cx: &mut Context<BrowserWindowView>,
) {
    let (state, host, key, p, sidebar_width, trailing) = {
        let layout = view.layout;
        (
            Arc::clone(&view.state),
            Arc::clone(&view.host),
            view.window_id.as_str().to_owned(),
            view.look.p,
            layout.map_or(ardia_theme::layout::DEFAULT_SIDEBAR_WIDTH, |l| {
                l.sidebar_width
            }),
            layout.is_some_and(|l| l.trailing),
        )
    };
    crate::sidebar::search_tabs::close(&key);
    crate::sidebar::tab_switcher::cancel(&key);
    let viewport = window.viewport_size();
    let room = Room {
        width: crate::scale::points(viewport.width),
        height: crate::scale::points(viewport.height),
    };
    let mouse = window.mouse_position();
    let inset = ardia_theme::layout::sidebar::INSET;
    let anchor = Some(Anchor {
        x: if trailing {
            room.width - sidebar_width + inset
        } else {
            inset
        },
        y: crate::scale::points(mouse.y),
        width: (sidebar_width - 2.0 * inset).max(0.0),
        height: ardia_theme::layout::sidebar::row_height(),
    });
    let current = current_icon(&state, &target);
    let row = pinned_row(&state, &target);
    let actions = actions(row, current.as_deref());
    let height = tokens::height(!actions.is_empty());
    let place_at = place(anchor, sidebar_width, trailing, height, room);
    let picker = cx.new(|cx| {
        IconPickerView::new(
            host,
            PickerSetup {
                current,
                symbols: SIDEBAR_SYMBOLS,
                actions,
                place: place_at,
                p,
            },
            window,
            cx,
        )
    });
    let chosen_for = target.clone();
    let events_key = key.clone();
    let events = cx.subscribe(
        &picker,
        move |this: &mut BrowserWindowView, _, event, cx| {
            if let IconPickerEvent::Choose(icon) = event {
                this.host.dispatch(choice_action(&chosen_for, icon.clone()));
            }
            OPEN.with(|o| o.borrow_mut().remove(&events_key));
            cx.notify();
        },
    );
    OPEN.with(|o| {
        o.borrow_mut().insert(
            key,
            Open {
                target,
                view: picker,
                _events: events,
            },
        )
    });
    cx.notify();
}

pub fn is_open(window: &str) -> bool {
    OPEN.with(|o| o.borrow().contains_key(window))
}

pub fn close(window: &str) {
    OPEN.with(|o| o.borrow_mut().remove(window));
}

pub fn layer(c: &Chrome) -> Option<AnyElement> {
    let key = c.window.id.as_str().to_owned();
    let (view, target) = OPEN.with(|o| {
        o.borrow()
            .get(&key)
            .map(|open| (open.view.clone(), open.target.clone()))
    })?;
    let gone = match &target {
        Target::Tab(tab) => c.state.tab(tab.as_str()).is_none(),
        Target::Group(group) => !c.state.groups.contains_key(group),
    };
    if gone {
        close(&key);
        return None;
    }
    Some(
        div()
            .id("sidebar-icon-picker-layer")
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, move |_, window, _| {
                close(&key);
                window.refresh();
            })
            .child(view)
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_sits_beside_the_sidebar() {
        let room = Room {
            width: 1400.0,
            height: 900.0,
        };
        let left = beside_sidebar(None, 240.0, false, room.width);
        assert_eq!(left, 246.0);
        let right = beside_sidebar(None, 240.0, true, room.width);
        assert_eq!(right, 1400.0 - 240.0 - 6.0 - tokens::WIDTH);
        let near = place(
            Some(Anchor {
                x: 9.0,
                y: 300.0,
                width: 222.0,
                height: 34.0,
            }),
            240.0,
            false,
            tokens::height(true),
            room,
        );
        assert_eq!(near.top, 292.0);
        assert_eq!(near.left, 237.0);
    }

    #[test]
    fn rows_offer_no_icon_and_custom_icons_offer_reset() {
        assert!(actions(false, None).is_empty());
        let row = actions(true, None);
        assert_eq!(row.len(), 1);
        assert_eq!(row[0].choice.as_deref(), Some(NO_ROW_ICON));
        let both = actions(true, Some("star"));
        assert_eq!(both.len(), 2);
        assert_eq!(both[1].choice, None);
    }
}
