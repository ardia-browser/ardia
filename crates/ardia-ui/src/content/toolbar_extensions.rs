use std::cell::RefCell;
use std::sync::Arc;

use ardia_state::{TabId, WindowId};
use gpui::{Hsla, SharedString, rgb, rgba};

use crate::content::toolbar::{ToolbarAction, ToolbarFeed};
use crate::host::UiHost;
use crate::host_data::{ExtensionList, drop_index, make_room_shift};

pub fn toolbar_actions(list: &ExtensionList, open_popup: Option<&str>) -> Vec<ToolbarAction> {
    list.toolbar()
        .into_iter()
        .map(|item| ToolbarAction {
            id: item.id.clone(),
            title: SharedString::from(item.tooltip().to_owned()),
            icon: item.icon.clone(),
            badge: (!item.badge.is_empty()).then(|| SharedString::from(item.badge.clone())),
            badge_fill: Some(badge_fill(item.badge_color.as_deref())),
            badge_ink: Some(badge_ink(
                item.badge_text_color.as_deref(),
                badge_fill(item.badge_color.as_deref()),
            )),
            enabled: item.action_enabled,
            open: open_popup == Some(item.id.as_str()),
        })
        .collect()
}

pub const BADGE_FALLBACK_FILL: u32 = 0x5F6368;

pub fn parse_color(text: &str) -> Option<Hsla> {
    let hex = text.trim().strip_prefix('#')?;
    let value = u32::from_str_radix(hex, 16).ok()?;
    match hex.len() {
        6 => Some(rgb(value).into()),
        8 => Some(rgba(value).into()),
        _ => None,
    }
}

pub fn badge_fill(color: Option<&str>) -> Hsla {
    color
        .and_then(parse_color)
        .filter(|fill| *fill != Hsla::from(rgb(0x000000)))
        .unwrap_or_else(|| rgb(BADGE_FALLBACK_FILL).into())
}

pub fn badge_ink(color: Option<&str>, fill: Hsla) -> Hsla {
    color.and_then(parse_color).unwrap_or_else(|| {
        let rgba = fill.to_rgb();
        let luminance = 0.299 * rgba.r + 0.587 * rgba.g + 0.114 * rgba.b;
        if luminance > 0.5 {
            gpui::black()
        } else {
            gpui::white()
        }
    })
}

pub fn feed_from_host(host: &dyn UiHost, window: &WindowId, active: Option<&TabId>) -> ToolbarFeed {
    let list = host.extensions(window);
    let popup = host.extension_popup(window);
    let actions = toolbar_actions(&list, popup.as_ref().map(|p| p.extension_id.as_str()));
    let mut feed = ToolbarFeed::default();
    let shown_profile = host
        .store()
        .read(|state| state.window(window.as_str()).map(|w| w.profile_id.clone()))
        .or(list.profile);
    if let Some(profile) = shown_profile {
        feed.actions.insert(profile, Arc::from(actions));
    }
    if let Some(tab) = active
        && host.casting(window)
    {
        feed.casting.insert(tab.clone());
    }
    feed
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionDrag {
    pub window: WindowId,
    pub id: String,
    pub from: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct DragState {
    window: WindowId,
    id: String,
    from: usize,
    start: Option<f32>,
    dx: f32,
}

thread_local! {
    static DRAG: RefCell<Option<DragState>> = const { RefCell::new(None) };
}

pub fn drag_started(window: &WindowId, id: &str, from: usize) {
    DRAG.with(|drag| {
        *drag.borrow_mut() = Some(DragState {
            window: window.clone(),
            id: id.to_owned(),
            from,
            start: None,
            dx: 0.0,
        })
    });
}

pub fn drag_moved(x: f32) {
    DRAG.with(|drag| {
        if let Some(state) = drag.borrow_mut().as_mut() {
            let start = *state.start.get_or_insert(x);
            state.dx = x - start;
        }
    });
}

pub fn drag_of(window: &WindowId) -> Option<(String, usize, f32)> {
    DRAG.with(|drag| {
        drag.borrow()
            .as_ref()
            .filter(|state| &state.window == window)
            .map(|state| (state.id.clone(), state.from, state.dx))
    })
}

pub fn drag_ended() -> Option<(String, usize, f32)> {
    DRAG.with(|drag| {
        drag.borrow_mut()
            .take()
            .map(|state| (state.id, state.from, state.dx))
    })
}

pub fn slot_shift(window: &WindowId, index: usize, pitch: f32, count: usize) -> f32 {
    match drag_of(window) {
        Some((_, from, dx)) if from == index => {
            let lowest = -(from as f32) * pitch;
            let highest =
                (count.saturating_sub(1) - from.min(count.saturating_sub(1))) as f32 * pitch;
            dx.clamp(lowest, highest)
        }
        Some((_, from, dx)) => make_room_shift(index, Some((from, dx)), pitch, count),
        None => 0.0,
    }
}

pub fn drop_target(from: usize, dx: f32, pitch: f32, count: usize) -> Option<usize> {
    let to = drop_index(from, dx, pitch, count);
    (to != from).then_some(to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_data::ExtensionItem;

    fn item(id: &str, pinned: Option<u32>, badge: &str) -> ExtensionItem {
        ExtensionItem {
            id: id.to_owned(),
            name: id.to_uppercase(),
            enabled: true,
            pinned: pinned.is_some(),
            pinned_index: pinned,
            has_action: true,
            badge: badge.to_owned(),
            ..ExtensionItem::default()
        }
    }

    #[test]
    fn pinned_extensions_become_toolbar_actions_in_pin_order() {
        let list = ExtensionList {
            profile: None,
            loaded: true,
            items: Arc::new(vec![
                item("b", Some(1), ""),
                item("hidden", None, ""),
                item("a", Some(0), "3"),
            ]),
        };
        let actions = toolbar_actions(&list, Some("b"));
        let ids: Vec<&str> = actions.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert_eq!(actions[0].badge.as_deref(), Some("3"));
        assert!(!actions[0].open);
        assert!(actions[1].open);
        assert!(actions[1].badge.is_none());
    }

    #[test]
    fn dragging_moves_a_button_and_makes_room_like_the_old_toolbar() {
        let window = WindowId::new("w");
        drag_started(&window, "b", 1);
        drag_moved(100.0);
        drag_moved(160.0);
        assert_eq!(slot_shift(&window, 1, 30.0, 3), 30.0);
        assert_eq!(slot_shift(&window, 2, 30.0, 3), -30.0);
        assert_eq!(slot_shift(&window, 0, 30.0, 3), 0.0);
        assert_eq!(slot_shift(&WindowId::new("other"), 2, 30.0, 3), 0.0);
        let (id, from, dx) = drag_ended().unwrap();
        assert_eq!((id.as_str(), from), ("b", 1));
        assert_eq!(drop_target(from, dx, 30.0, 3), Some(2));
        assert_eq!(drop_target(1, 4.0, 30.0, 3), None);
        assert!(drag_ended().is_none());
    }

    #[test]
    fn badges_use_the_extension_colour_or_the_old_grey() {
        let grey: Hsla = rgb(BADGE_FALLBACK_FILL).into();
        assert_eq!(badge_fill(None), grey);
        assert_eq!(badge_fill(Some("#000000")), grey);
        assert_eq!(badge_fill(Some("not a colour")), grey);
        assert_eq!(badge_fill(Some("#FF0000")), Hsla::from(rgb(0xFF0000)));
        assert_eq!(badge_ink(None, rgb(0xFFFF00).into()), gpui::black());
        assert_eq!(badge_ink(None, grey), gpui::white());
        assert_eq!(badge_ink(Some("#00FF00"), grey), Hsla::from(rgb(0x00FF00)));
    }
}
