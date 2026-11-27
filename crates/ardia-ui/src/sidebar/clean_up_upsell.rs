use std::cell::Cell;

use crate::scale::px;
use ardia_state::Action;
use ardia_state::clean_up::{
    DAILY_CLEAN_UP_MINUTES, UPSELL_MIN, clean_up_candidates, inactive_after_ms, upsell_wanted,
};
use ardia_state::settings::SettingsPatch;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    div, hsla, prelude::*,
};

use crate::msg::{Emit, Msg};
use crate::primitives::controls::{CloseButton, CloseLook, PillButton, PillSize};
use crate::primitives::icons::{Icon, icon};
use crate::window::chrome::Chrome;

pub const CARD_TOP: f32 = 10.0;
pub const CARD_RADIUS: f32 = 12.0;
pub const CARD_PAD: f32 = 10.0;
pub const CARD_GAP: f32 = 6.0;

thread_local! {
    static DECLINED: Cell<bool> = const { Cell::new(false) };
    static SHOWN_NOTED: Cell<bool> = const { Cell::new(false) };
}

pub fn shown_count(candidates: usize, wanted: bool, declined: bool) -> Option<usize> {
    (wanted && !declined && candidates >= UPSELL_MIN).then_some(candidates)
}

fn group_fill(dark: bool) -> (Hsla, Hsla) {
    if dark {
        (hsla(0., 0., 1., 0.10), hsla(0., 0., 1., 0.10))
    } else {
        (hsla(0., 0., 0., 0.05), hsla(0., 0., 0., 0.10))
    }
}

fn decline(window: &mut gpui::Window) {
    DECLINED.with(|d| d.set(true));
    window.refresh();
}

fn send_all(emit: &Emit, msgs: Vec<Msg>, window: &mut gpui::Window, cx: &mut gpui::App) {
    for msg in msgs {
        emit.send(msg, window, cx);
    }
}

pub const UNDO_PREFIX: &str = "undoCleanUp:";

pub fn cleaned_message(count: usize) -> String {
    if count == 1 {
        "Cleaned Up 1 Tab".to_owned()
    } else {
        format!("Cleaned Up {count} Tabs")
    }
}

pub fn clean_up_messages(
    window: &ardia_state::WindowId,
    tabs: Vec<ardia_state::TabId>,
) -> Vec<Msg> {
    if tabs.is_empty() {
        return Vec::new();
    }
    let undo = format!(
        "{UNDO_PREFIX}{}",
        tabs.iter()
            .map(|t| t.as_str())
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut toast = crate::popovers::toast::toast(
        cleaned_message(tabs.len()),
        ardia_state::windows::ToastKind::Undo,
        Some(&undo),
        ardia_state::store::now_ms(),
    );
    toast.icon = Some("wand.and.stars".to_owned());
    vec![
        Msg::Store(Action::CleanUpTabs { tabs }),
        Msg::Store(Action::PushToast {
            window: window.clone(),
            toast,
        }),
    ]
}

pub fn clean_up_now(state: &ardia_state::BrowserState, window: &ardia_state::WindowId) -> Vec<Msg> {
    let now = ardia_state::store::now_ms();
    let tabs = clean_up_candidates(state, window.as_str(), inactive_after_ms(state), now);
    clean_up_messages(window, tabs)
}

pub fn can_undo(state: &ardia_state::BrowserState, arg: &str) -> bool {
    arg.split(',').filter(|s| !s.is_empty()).all(|wanted| {
        state
            .closed
            .cleaned_tabs
            .iter()
            .any(|c| c.tab_id.as_ref().is_some_and(|t| t.as_str() == wanted))
    })
}

pub fn undo_actions(
    state: &ardia_state::BrowserState,
    window: &ardia_state::WindowId,
    arg: &str,
) -> Vec<Action> {
    let wanted: Vec<&str> = arg.split(',').filter(|s| !s.is_empty()).collect();
    state
        .closed
        .cleaned_tabs
        .iter()
        .filter(|c| {
            c.tab_id
                .as_ref()
                .is_some_and(|t| wanted.contains(&t.as_str()))
        })
        .map(|c| Action::RestoreClosed {
            id: c.id.clone(),
            window: Some(window.clone()),
        })
        .collect()
}

pub fn upsell(c: &Chrome) -> Option<AnyElement> {
    let now = ardia_state::store::now_ms();
    let window_key = c.window.id.as_str();
    let candidates = clean_up_candidates(c.state, window_key, inactive_after_ms(c.state), now);
    let Some(count) = shown_count(
        candidates.len(),
        upsell_wanted(c.state),
        DECLINED.with(Cell::get),
    ) else {
        SHOWN_NOTED.with(|noted| noted.set(false));
        return None;
    };
    if !SHOWN_NOTED.with(|noted| noted.replace(true)) {
        ardia_telemetry::counts::count("clean_up_suggestion_shows");
    }
    let p = *c.p;
    let (fill, stroke) = group_fill(c.look.dark);
    let close_tabs = clean_up_messages(&c.window.id, candidates);
    let daily = Msg::Store(Action::UpdateSettings {
        patch: SettingsPatch::new().set("cleanUpInactiveTabsAfterMinutes", DAILY_CLEAN_UP_MINUTES),
        from_sync: false,
    });
    let never = Msg::Store(Action::UpdateSettings {
        patch: SettingsPatch::new().set("suggestCleanUp", false),
        from_sync: false,
    });
    let (now_emit, daily_emit, never_emit) = (c.emit.clone(), c.emit.clone(), c.emit.clone());
    let once = close_tabs.clone();
    Some(
        div()
            .id("clean-up-upsell")
            .debug_selector(|| "clean-up-upsell".into())
            .mt(px(CARD_TOP))
            .p(px(CARD_PAD))
            .rounded(px(CARD_RADIUS))
            .bg(fill)
            .border(px(0.5))
            .border_color(stroke)
            .flex()
            .flex_col()
            .gap(px(CARD_GAP))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(CARD_GAP))
                    .child(
                        div()
                            .flex_none()
                            .size(px(16.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(Icon::Wand, 12.0, p.icon)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.text)
                            .child(SharedString::from(format!("{count} unused tabs"))),
                    )
                    .child(
                        div().my(px(-4.0)).mr(px(-4.0)).child(
                            CloseButton::new("clean-up-not-now", CloseLook::Panel, c.p)
                                .tooltip("Not Now")
                                .on_click(|_, window, _| {
                                    ardia_telemetry::counts::count("clean_up_suggestion_not_now");
                                    decline(window)
                                }),
                        ),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.0))
                    .text_color(p.text_secondary)
                    .child(SharedString::new_static(
                        "Auto Clean Up clears any tab unused for a day.",
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(CARD_GAP))
                    .child(
                        PillButton::new("clean-up-now", "Clean Up Now", c.p)
                            .chip()
                            .primary(true)
                            .size(PillSize::M)
                            .on_click(move |_, window, cx| {
                                ardia_telemetry::counts::count("clean_up_suggestion_once");
                                send_all(&now_emit, once.clone(), window, cx);
                                decline(window);
                            }),
                    )
                    .child(
                        PillButton::new("clean-up-daily", "Auto Clean Up", c.p)
                            .chip()
                            .size(PillSize::M)
                            .on_click(move |_, window, cx| {
                                ardia_telemetry::counts::count("clean_up_suggestion_daily");
                                send_all(
                                    &daily_emit,
                                    std::iter::once(daily.clone())
                                        .chain(close_tabs.iter().cloned())
                                        .collect(),
                                    window,
                                    cx,
                                );
                            }),
                    ),
            )
            .child(
                div().flex().justify_center().mt(px(-2.0)).child(
                    div()
                        .id("clean-up-never")
                        .text_size(px(12.0))
                        .text_color(p.text_tertiary)
                        .hover(move |s| s.text_color(p.text_secondary))
                        .cursor_pointer()
                        .on_click(move |_, window, cx| {
                            ardia_telemetry::counts::count("clean_up_suggestion_never_again");
                            send_all(&never_emit, vec![never.clone()], window, cx)
                        })
                        .child(SharedString::new_static("Don’t show again")),
                ),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_shows_from_ten_candidates_until_declined() {
        assert_eq!(shown_count(9, true, false), None);
        assert_eq!(shown_count(10, true, false), Some(10));
        assert_eq!(shown_count(30, true, true), None);
        assert_eq!(shown_count(30, false, false), None);
    }

    #[test]
    fn the_undo_toast_counts_tabs_and_names_them_in_its_command() {
        assert_eq!(cleaned_message(1), "Cleaned Up 1 Tab");
        assert_eq!(cleaned_message(3), "Cleaned Up 3 Tabs");
        let window = ardia_state::WindowId::new("w");
        assert!(clean_up_messages(&window, Vec::new()).is_empty());
        let msgs = clean_up_messages(
            &window,
            vec![ardia_state::TabId::new("a"), ardia_state::TabId::new("b")],
        );
        assert_eq!(msgs.len(), 2);
        match &msgs[1] {
            Msg::Store(Action::PushToast { toast, .. }) => {
                assert_eq!(toast.action.as_deref(), Some("undoCleanUp:a,b"));
                assert_eq!(toast.message, "Cleaned Up 2 Tabs");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
