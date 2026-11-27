use std::sync::atomic::{AtomicU64, Ordering};

use crate::scale::px;
use ardia_state::windows::{Toast, ToastKind};
use gpui::{
    AnyElement, App, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::*,
};

use std::time::Duration;

use gpui::{Animation, AnimationExt};

use crate::msg::Msg;
use crate::primitives::icons::Icon;
use crate::primitives::sheets::{
    TOAST_FADE_IN, TOAST_FADE_OUT, chip_button, chip_button_focusable,
    toast_card_lines as sheet_toast,
};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const TOAST_MS: i64 = 2_600;
pub const TOAST_ACTION_MS: i64 = 4_000;
pub const BOTTOM: f32 = 24.0;
pub const REVEAL_ACTION: &str = "reveal:";
pub const SHOW_SYNCED_TAB: &str = "showSyncedTab:";
pub const OPEN_SETTINGS_ACTION: &str = "openSettings";
pub const BUSY_TAB_ACTION: &str = "busyTab:";
pub const BUSY_TAB_SLEEP: &str = "busyTabSleep:";
pub const BUSY_TAB_KEEP: &str = "busyTabKeep:";

pub fn toast_buttons(action: &str) -> Vec<(&'static str, String)> {
    match action.strip_prefix(BUSY_TAB_ACTION) {
        Some(warning) => vec![
            ("Keep Running", format!("{BUSY_TAB_KEEP}{warning}")),
            ("Sleep", format!("{BUSY_TAB_SLEEP}{warning}")),
        ],
        None => Vec::new(),
    }
}

pub fn reveal_target(command: &str) -> Option<&str> {
    command
        .strip_prefix(REVEAL_ACTION)
        .filter(|path| !path.is_empty())
}

fn action_title(toast: &Toast, action: &str) -> &'static str {
    if action.starts_with(SHOW_SYNCED_TAB) {
        return "Show";
    }
    if reveal_target(action).is_some() {
        if cfg!(target_os = "macos") {
            "Show in Finder"
        } else {
            "Show in File Explorer"
        }
    } else if action == OPEN_SETTINGS_ACTION {
        "Open Settings"
    } else if toast.kind == ToastKind::Undo {
        "Undo"
    } else {
        "Open"
    }
}

static NEXT_TOAST: AtomicU64 = AtomicU64::new(1);

pub const UNDO_CLEAR_ACTION: &str = "undoClearTabs";

thread_local! {
    static WITHDRAWN: std::cell::RefCell<std::collections::HashSet<u64>> =
        std::cell::RefCell::new(std::collections::HashSet::new());
}

pub fn undo_still_possible(
    state: &ardia_state::BrowserState,
    window: &ardia_state::WindowId,
    action: &str,
) -> bool {
    if action == UNDO_CLEAR_ACTION {
        return ardia_state::closed::can_undo_clear(state, window);
    }
    if let Some(arg) = action.strip_prefix(crate::sidebar::tidy_tabs::UNDO_TIDY_PREFIX) {
        return crate::sidebar::tidy_tabs::can_undo(state, arg);
    }
    if let Some(arg) = action.strip_prefix(crate::sidebar::sort_tabs::UNDO_SORT_PREFIX) {
        return crate::sidebar::sort_tabs::can_undo(state, arg);
    }
    if let Some(arg) = action.strip_prefix(crate::sidebar::clean_up_upsell::UNDO_PREFIX) {
        return crate::sidebar::clean_up_upsell::can_undo(state, arg);
    }
    true
}

pub fn still_shown(
    state: &ardia_state::BrowserState,
    window: &ardia_state::WindowId,
    toast: &Toast,
) -> bool {
    if toast.kind != ToastKind::Undo {
        return true;
    }
    if WITHDRAWN.with(|w| w.borrow().contains(&toast.id)) {
        return false;
    }
    let possible = toast
        .action
        .as_deref()
        .is_none_or(|action| undo_still_possible(state, window, action));
    if !possible {
        WITHDRAWN.with(|w| w.borrow_mut().insert(toast.id));
    }
    possible
}

pub fn next_toast_id() -> u64 {
    NEXT_TOAST.fetch_add(1, Ordering::Relaxed)
}

pub fn toast(message: impl Into<String>, kind: ToastKind, action: Option<&str>, now: i64) -> Toast {
    Toast {
        id: next_toast_id(),
        kind,
        message: message.into(),
        action: action.map(str::to_owned),
        icon: None,
        created_at: now,
        expires_at: Some(
            now + if action.is_some() {
                TOAST_ACTION_MS
            } else {
                TOAST_MS
            },
        ),
    }
}

fn toast_icon(toast: &Toast) -> Option<Icon> {
    if let Some(symbol) = toast.icon.as_deref() {
        return Icon::from_symbol(symbol);
    }
    match toast.kind {
        ToastKind::Undo => Some(Icon::Download),
        ToastKind::Error => Some(Icon::Warning),
        _ => None,
    }
}

const BUSY_TAB_TITLE_LINES: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ToastHold {
    pub hovered: Option<u64>,
    pub focused: Option<u64>,
    pub restarted: Option<(u64, i64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldBy {
    Pointer,
    Focus,
}

impl ToastHold {
    pub fn holds(&self, toast: &Toast) -> bool {
        self.holds_id(toast.id)
    }

    fn holds_id(&self, id: u64) -> bool {
        self.hovered == Some(id) || self.focused == Some(id)
    }

    pub fn deadline(&self, toast: &Toast) -> Option<i64> {
        let expires = toast.expires_at?;
        if self.holds(toast) {
            return None;
        }
        match self.restarted {
            Some((id, at)) if id == toast.id => Some(at + (expires - toast.created_at).max(0)),
            _ => Some(expires),
        }
    }

    pub fn press(&mut self, id: u64, by: HoldBy, held: bool, now: i64) {
        let was = self.holds_id(id);
        let slot = match by {
            HoldBy::Pointer => &mut self.hovered,
            HoldBy::Focus => &mut self.focused,
        };
        if held {
            *slot = Some(id);
        } else if *slot == Some(id) {
            *slot = None;
        }
        if was && !self.holds_id(id) {
            self.restarted = Some((id, now));
        }
    }

    pub fn forget(&mut self, alive: impl Fn(u64) -> bool) {
        if self.hovered.is_some_and(|id| !alive(id)) {
            self.hovered = None;
        }
        if self.focused.is_some_and(|id| !alive(id)) {
            self.focused = None;
        }
    }
}

pub fn holds_on_hover(toast: &Toast) -> bool {
    toast
        .action
        .as_deref()
        .is_some_and(|action| toast_buttons(action).len() > 1)
}

pub fn title_lines(toast: &Toast) -> Option<usize> {
    toast
        .action
        .as_deref()
        .filter(|action| action.starts_with(BUSY_TAB_ACTION))
        .map(|_| BUSY_TAB_TITLE_LINES)
}

pub fn toast_opacity_now(toast: &Toast, hold: &ToastHold, now: i64, entered: bool) -> f32 {
    let fade_in = TOAST_FADE_IN.0.as_secs_f32() * 1000.0;
    let fade_out = fade_out_ms();
    let since = (now - toast.created_at).max(0) as f32;
    let entering = if entered {
        1.0
    } else {
        TOAST_FADE_IN.1.ease(since / fade_in)
    };
    let leaving = match hold.deadline(toast) {
        Some(deadline) => 1.0 - TOAST_FADE_OUT.1.ease((now - deadline) as f32 / fade_out),
        None => 1.0,
    };
    entering.min(leaving).clamp(0.0, 1.0)
}

pub fn fade_out_ms() -> f32 {
    TOAST_FADE_OUT.0.as_secs_f32() * 1000.0
}

pub fn toast_opacity(elapsed_ms: f32, total_ms: f32) -> f32 {
    let fade_in = TOAST_FADE_IN.0.as_secs_f32() * 1000.0;
    let fade_out = TOAST_FADE_OUT.0.as_secs_f32() * 1000.0;
    let entering = TOAST_FADE_IN.1.ease(elapsed_ms / fade_in);
    let leaving = 1.0 - TOAST_FADE_OUT.1.ease((elapsed_ms - total_ms) / fade_out);
    entering.min(leaving).clamp(0.0, 1.0)
}

fn toast_card(c: &Chrome, toast: &Toast, room: f32) -> AnyElement {
    let p = *c.p;
    let buttons: Vec<(&'static str, String)> = toast
        .action
        .clone()
        .map(|action| {
            let pair = toast_buttons(&action);
            if pair.is_empty() {
                vec![(action_title(toast, &action), action)]
            } else {
                pair
            }
        })
        .unwrap_or_default();
    let two_buttons = buttons.len() > 1;
    let actions: Vec<AnyElement> = buttons
        .into_iter()
        .enumerate()
        .map(|(index, (title, action))| {
            let emit = c.emit.clone();
            let id = toast.id;
            let command = SharedString::from(action);
            let element_id = if index == 0 {
                format!("toast-action:{id}")
            } else {
                format!("toast-action:{id}:{index}")
            };
            let send = move |window: &mut Window, cx: &mut App| {
                emit.send(
                    Msg::ToastAction {
                        id,
                        command: command.clone(),
                    },
                    window,
                    cx,
                )
            };
            let focus = c
                .toast_focus
                .filter(|_| two_buttons)
                .and_then(|f| f.get(index));
            let chip = match focus {
                Some(handle) => chip_button_focusable(
                    SharedString::from(element_id),
                    title,
                    &p,
                    handle,
                    index as isize,
                    send,
                )
                .into_any_element(),
                None => chip_button(
                    SharedString::from(element_id),
                    title,
                    &p,
                    move |_, window, cx| send(window, cx),
                )
                .into_any_element(),
            };
            div()
                .debug_selector(|| "toast-action".into())
                .child(chip)
                .into_any_element()
        })
        .collect();
    let hold = c.ui.toast_hold;
    let now = ardia_state::store::now_ms();
    let end = hold
        .deadline(toast)
        .map_or(now + TOAST_ACTION_MS, |deadline| {
            deadline + fade_out_ms() as i64
        });
    let remaining = (end - now).max(1) as f32;
    let restart = hold
        .restarted
        .filter(|(id, _)| *id == toast.id)
        .map_or(0, |(_, at)| at);
    let held = hold.holds(toast);
    let hoverable = holds_on_hover(toast);
    let lines = title_lines(toast);
    let (title, detail) = match toast.message.split_once('\n') {
        Some((title, detail)) => (
            title.to_owned(),
            Some(SharedString::from(detail.to_owned())),
        ),
        None => (toast.message.clone(), None),
    };
    let id = toast.id;
    let emit = c.emit.clone();
    let shown = toast.clone();
    sheet_toast(
        &p,
        SharedString::from(title),
        detail,
        toast_icon(toast),
        Some(room),
        actions,
        lines,
    )
    .id(SharedString::from(format!("toast:{id}")))
    .debug_selector(|| "toast".into())
    .occlude()
    .when(hoverable, |card| {
        card.on_hover(move |hovered, window, cx| {
            emit.send(
                Msg::ToastHeld {
                    id,
                    by: HoldBy::Pointer,
                    held: *hovered,
                },
                window,
                cx,
            )
        })
    })
    .with_animation(
        SharedString::from(format!("toast-fade:{id}:{restart}:{held}")),
        Animation::new(Duration::from_secs_f32(remaining / 1000.0)),
        move |card, delta| {
            let now = ardia_state::store::now_ms();
            let entered = delta >= 1.0 && now < end - fade_out_ms() as i64;
            card.opacity(toast_opacity_now(&shown, &hold, now, entered))
        },
    )
    .into_any_element()
}

pub fn toasts(c: &Chrome, page: Rect) -> Option<AnyElement> {
    let shown = c
        .window
        .chrome
        .toasts
        .back()
        .filter(|toast| still_shown(c.state, &c.window.id, toast))?;
    Some(
        div()
            .id("toasts")
            .debug_selector(|| "toasts".into())
            .absolute()
            .left(px(page.x))
            .w(px(page.w))
            .bottom(px(c.layout.height - page.bottom() + BOTTOM))
            .flex()
            .flex_col()
            .items_center()
            .child(toast_card(c, shown, page.w))
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_fade_in_fast_and_out_slow() {
        assert_eq!(toast_opacity(0.0, 2_600.0), 0.0);
        assert!(toast_opacity(75.0, 2_600.0) > 0.5);
        assert_eq!(toast_opacity(1_000.0, 2_600.0), 1.0);
        assert_eq!(toast_opacity(2_600.0, 2_600.0), 1.0);
        assert!(toast_opacity(2_725.0, 2_600.0) < 1.0);
        assert_eq!(toast_opacity(2_850.0, 2_600.0), 0.0);
    }

    fn timed(id: u64, created_at: i64, expires_at: i64, action: Option<&str>) -> Toast {
        Toast {
            id,
            kind: ToastKind::Info,
            message: "m".into(),
            action: action.map(str::to_owned),
            icon: None,
            created_at,
            expires_at: Some(expires_at),
        }
    }

    #[test]
    fn hovering_a_two_button_toast_holds_it_and_leaving_restarts_the_full_hold() {
        let busy = timed(7, 1_000, 21_000, Some("busyTab:7"));
        let mut hold = ToastHold::default();
        assert_eq!(hold.deadline(&busy), Some(21_000));
        hold.press(7, HoldBy::Pointer, true, 5_000);
        assert_eq!(hold.deadline(&busy), None);
        assert_eq!(toast_opacity_now(&busy, &hold, 60_000, false), 1.0);
        hold.press(7, HoldBy::Pointer, false, 60_000);
        assert_eq!(hold.deadline(&busy), Some(80_000));
        assert_eq!(toast_opacity_now(&busy, &hold, 79_000, false), 1.0);
        assert_eq!(toast_opacity_now(&busy, &hold, 80_000 + 400, false), 0.0);
        assert!(holds_on_hover(&busy));
        assert!(!holds_on_hover(&timed(8, 0, 4_000, Some("undoClearTabs"))));
        assert_eq!(title_lines(&busy), Some(2));
        assert_eq!(title_lines(&timed(8, 0, 4_000, None)), None);
    }

    #[test]
    fn a_focused_button_holds_the_toast_until_both_focus_and_pointer_leave() {
        let busy = timed(7, 1_000, 21_000, Some("busyTab:7"));
        let mut hold = ToastHold::default();
        hold.press(7, HoldBy::Focus, true, 2_000);
        assert_eq!(hold.deadline(&busy), None);
        hold.press(7, HoldBy::Pointer, true, 3_000);
        hold.press(7, HoldBy::Focus, false, 4_000);
        assert_eq!(hold.deadline(&busy), None, "the pointer still holds it");
        assert_eq!(hold.restarted, None);
        hold.press(7, HoldBy::Pointer, false, 9_000);
        assert_eq!(hold.deadline(&busy), Some(29_000));
        hold.press(7, HoldBy::Focus, true, 10_000);
        hold.forget(|id| id != 7);
        assert_eq!(hold.deadline(&busy), Some(29_000));
    }

    #[test]
    fn a_toast_drawn_late_shows_the_opacity_for_its_age() {
        let toast = timed(9, 0, 2_600, None);
        let hold = ToastHold::default();
        assert_eq!(toast_opacity_now(&toast, &hold, 0, false), 0.0);
        assert_eq!(toast_opacity_now(&toast, &hold, 0, true), 1.0);
        assert_eq!(toast_opacity_now(&toast, &hold, 1_300, false), 1.0);
        assert_eq!(toast_opacity_now(&toast, &hold, 2_600, false), 1.0);
        assert!(toast_opacity_now(&toast, &hold, 2_725, false) < 1.0);
        assert_eq!(toast_opacity_now(&toast, &hold, 2_900, false), 0.0);
    }

    #[test]
    fn busy_tab_warnings_offer_keep_running_then_sleep() {
        assert_eq!(
            toast_buttons("busyTab:42"),
            vec![
                ("Keep Running", "busyTabKeep:42".to_owned()),
                ("Sleep", "busyTabSleep:42".to_owned())
            ]
        );
        assert!(toast_buttons("undoClearTabs").is_empty());
    }

    #[test]
    fn toasts_get_unique_ids_and_expire() {
        let a = toast(
            "Cleared 3 tabs",
            ToastKind::Undo,
            Some("undoClearTabs"),
            1_000,
        );
        let b = toast("Copied", ToastKind::Info, None, 1_000);
        assert_ne!(a.id, b.id);
        assert_eq!(a.expires_at, Some(1_000 + TOAST_ACTION_MS));
        assert_eq!(b.expires_at, Some(1_000 + TOAST_MS));
        assert_eq!(a.action.as_deref(), Some("undoClearTabs"));
    }
}
