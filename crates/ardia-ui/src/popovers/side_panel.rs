use ardia_state::Action;
use ardia_state::settings::SettingsPatch;
use ardia_theme::tokens::{TypeSize, space};
use gpui::{
    AnyElement, FontWeight, IntoElement, ObjectFit, ParentElement, SharedString, Styled, div, img,
    prelude::*,
};

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Instant;

use ardia_state::TabId;
use ardia_theme::motion::ease_out_cubic;

use crate::host_data::SidePanelView;
use crate::msg::{MenuTarget, Msg};
use crate::primitives::controls::{EmptyDrag, IconButton};
use crate::primitives::icons::Icon;
use crate::scale::px;
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const MIN_WIDTH: f32 = 320.0;
pub const MAX_WIDTH: f32 = 600.0;
pub const DEFAULT_WIDTH: f32 = 360.0;
pub const HEADER: f32 = 40.0;
pub const GLYPH: f32 = 13.0;
pub const HEADER_PAD_RIGHT: f32 = space::XS;

#[derive(Clone, Debug, PartialEq)]
pub struct SidePanelResize;

pub fn panel_width(saved: f64) -> f32 {
    if saved.is_finite() {
        (saved as f32).clamp(MIN_WIDTH, MAX_WIDTH)
    } else {
        DEFAULT_WIDTH
    }
}

pub fn room(saved: f64, gap: f32) -> f32 {
    panel_width(saved) + gap
}

pub const APPEAR_MS: f32 = 150.0;

#[derive(Clone, Debug)]
struct Appear {
    shown: bool,
    wanted: bool,
    tab: Option<TabId>,
    from: f32,
    to: f32,
    started: Instant,
    span_ms: f32,
    card: Option<SidePanelView>,
}

thread_local! {
    static APPEARS: RefCell<HashMap<String, Appear>> = RefCell::new(HashMap::new());
}

impl Appear {
    fn at(&self, now: Instant) -> (f32, bool) {
        if self.span_ms <= 0.0 {
            return (self.to, false);
        }
        let t = now.saturating_duration_since(self.started).as_secs_f32() * 1000.0 / self.span_ms;
        if t >= 1.0 {
            return (self.to, false);
        }
        let eased = ease_out_cubic(f64::from(t)) as f32;
        (self.from + (self.to - self.from) * eased, true)
    }
}

#[derive(Clone, Debug)]
pub struct Shown {
    pub appear: f32,
    pub moving: bool,
    pub panel: Option<SidePanelView>,
    pub current: bool,
}

pub fn instant_switch(was_wanted: bool, wanted: bool, tab_changed: bool) -> bool {
    was_wanted && wanted && tab_changed
}

pub fn appear(
    window: &str,
    panel: Option<SidePanelView>,
    wanted: bool,
    tab: Option<&TabId>,
    now: Instant,
) -> Shown {
    APPEARS.with(|appears| {
        let mut appears = appears.borrow_mut();
        let shown = panel.is_some();
        let state = appears.entry(window.to_owned()).or_insert_with(|| Appear {
            shown,
            wanted,
            tab: tab.cloned(),
            from: if shown { 1.0 } else { 0.0 },
            to: if shown { 1.0 } else { 0.0 },
            started: now,
            span_ms: 0.0,
            card: panel.clone(),
        });
        if state.shown != shown {
            let tab_changed = tab.is_some() && tab != state.tab.as_ref();
            let instant = instant_switch(state.wanted, wanted, tab_changed);
            let (at, _) = state.at(now);
            state.from = if instant {
                if shown { 1.0 } else { 0.0 }
            } else {
                at
            };
            state.to = if shown { 1.0 } else { 0.0 };
            state.started = now;
            state.span_ms = if instant { 0.0 } else { APPEAR_MS };
            state.shown = shown;
            if instant {
                state.card = None;
            }
        }
        state.wanted = wanted;
        state.tab = tab.cloned();
        if let Some(panel) = &panel {
            state.card = Some(panel.clone());
        }
        let (value, moving) = state.at(now);
        if !shown && !moving {
            state.card = None;
        }
        Shown {
            appear: value,
            moving,
            panel: panel.clone().or_else(|| state.card.clone()),
            current: shown,
        }
    })
}

fn width_msg(width: f32) -> Msg {
    Msg::Store(Action::UpdateSettings {
        patch: SettingsPatch::new().set(
            "extensionSidePanelWidth",
            serde_json::json!(f64::from(width.clamp(MIN_WIDTH, MAX_WIDTH).round())),
        ),
        from_sync: false,
    })
}

pub fn side_panel(
    c: &Chrome,
    panel: &SidePanelView,
    card: Rect,
    body: Option<AnyElement>,
    appear: f32,
) -> AnyElement {
    let p = c.p;
    let width = panel_width(c.state.settings.extension_side_panel_width);
    let gap = c.layout.frame.split_gap;
    let reveal = (width + gap) * appear;
    let clip_x = card.x + card.w;
    let right_edge = clip_x + reveal;
    let extension = panel.extension_id.clone();
    let resize_emit = c.emit.clone();
    let reset_emit = c.emit.clone();
    let panel_card = div()
        .id("extension-side-panel")
        .debug_selector(|| "extension-side-panel".into())
        .absolute()
        .right_0()
        .top_0()
        .w(px(width))
        .h(px(card.h))
        .opacity(appear)
        .rounded(px(c.layout.frame.radius))
        .overflow_hidden()
        .bg(p.card)
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(HEADER))
                .flex_none()
                .flex()
                .items_center()
                .gap(px(space::M))
                .pl(px(space::L))
                .pr(px(HEADER_PAD_RIGHT))
                .when_some(panel.icon.clone(), |this, icon| {
                    this.child(
                        img(icon)
                            .size(px(16.))
                            .flex_none()
                            .object_fit(ObjectFit::Contain),
                    )
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(TypeSize::Body.points()))
                        .font_weight(FontWeight::MEDIUM)
                        .child(SharedString::from(panel.title.clone())),
                )
                .child(
                    div().debug_selector(|| "side-panel-more".into()).child(
                        IconButton::new("side-panel-more", Icon::Ellipsis, p)
                            .glyph(GLYPH)
                            .tooltip("More", p)
                            .on_click({
                                let emit = c.emit.clone();
                                move |event, window, cx| {
                                    emit.send(
                                        Msg::Menu(Some((
                                            MenuTarget::Extension(extension.clone()),
                                            event.position(),
                                        ))),
                                        window,
                                        cx,
                                    )
                                }
                            }),
                    ),
                )
                .child(
                    div().debug_selector(|| "side-panel-close".into()).child(
                        IconButton::new("side-panel-close", Icon::XMark, p)
                            .glyph(GLYPH)
                            .tooltip("Close Side Panel", p)
                            .on_click(c.emit.click(Msg::CloseSidePanel)),
                    ),
                ),
        )
        .child(div().h(px(0.5)).flex_none().bg(p.divider))
        .child(div().flex_1().min_h_0().bg(gpui::white()).children(body))
        .child(
            div()
                .id("side-panel-resize")
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(-3.))
                .w(px(7.))
                .cursor(gpui::CursorStyle::ResizeLeftRight)
                .on_click(move |event, window, cx| {
                    if event.click_count() == 2 {
                        reset_emit.send(width_msg(DEFAULT_WIDTH), window, cx);
                    }
                })
                .on_drag(SidePanelResize, |_, _, _, cx| cx.new(|_| EmptyDrag))
                .on_drag_move(
                    move |event: &gpui::DragMoveEvent<SidePanelResize>, window, cx| {
                        let x = crate::scale::points(event.event.position.x);
                        resize_emit.send(width_msg(right_edge - x), window, cx);
                    },
                ),
        );
    div()
        .absolute()
        .left(px(clip_x))
        .top(px(card.y))
        .w(px(reveal))
        .h(px(card.h))
        .overflow_hidden()
        .child(panel_card)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panels_keep_the_old_width_limits() {
        assert_eq!(panel_width(360.0), 360.0);
        assert_eq!(panel_width(100.0), MIN_WIDTH);
        assert_eq!(panel_width(9000.0), MAX_WIDTH);
        assert_eq!(panel_width(f64::NAN), DEFAULT_WIDTH);
        assert_eq!(room(400.0, 9.0), 409.0);
    }

    fn view(id: &str) -> SidePanelView {
        SidePanelView {
            extension_id: id.into(),
            title: "Panel".into(),
            icon: None,
            view: None,
        }
    }

    #[test]
    fn opening_slides_in_over_the_base_duration_and_closing_keeps_the_leaving_card() {
        let t0 = Instant::now();
        let tab = TabId::from("t");
        let closed = appear("w-slide", None, false, Some(&tab), t0);
        assert_eq!(closed.appear, 0.0);
        assert!(closed.panel.is_none());
        let opening = appear("w-slide", Some(view("e")), true, Some(&tab), t0);
        assert_eq!(opening.appear, 0.0);
        assert!(opening.moving);
        let mid = appear(
            "w-slide",
            Some(view("e")),
            true,
            Some(&tab),
            t0 + std::time::Duration::from_millis(75),
        );
        assert!(mid.appear > 0.5 && mid.appear < 1.0);
        let open = appear(
            "w-slide",
            Some(view("e")),
            true,
            Some(&tab),
            t0 + std::time::Duration::from_millis(151),
        );
        assert_eq!(open.appear, 1.0);
        assert!(!open.moving);
        let t1 = t0 + std::time::Duration::from_millis(200);
        let leaving = appear("w-slide", None, false, Some(&tab), t1);
        assert!(
            leaving.panel.is_some(),
            "the leaving card fades with the slide"
        );
        assert!(!leaving.current);
        let gone = appear(
            "w-slide",
            None,
            false,
            Some(&tab),
            t1 + std::time::Duration::from_millis(151),
        );
        assert!(gone.panel.is_none());
        assert_eq!(gone.appear, 0.0);
    }

    #[test]
    fn switching_to_a_tab_where_the_panel_is_hidden_is_instant() {
        let t0 = Instant::now();
        let (a, b) = (TabId::from("a"), TabId::from("b"));
        appear("w-instant", Some(view("e")), true, Some(&a), t0);
        let hidden = appear("w-instant", None, true, Some(&b), t0);
        assert_eq!(hidden.appear, 0.0);
        assert!(!hidden.moving);
        assert!(hidden.panel.is_none());
        let back = appear("w-instant", Some(view("e")), true, Some(&a), t0);
        assert_eq!(back.appear, 1.0);
        assert!(instant_switch(true, true, true));
        assert!(!instant_switch(false, true, true));
    }
}
