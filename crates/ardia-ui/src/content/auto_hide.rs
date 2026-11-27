use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use crate::scale::px;
use ardia_state::tabs::Tab;
use ardia_state::{BrowserState, TabId, WindowId};
use gpui::{
    AnyElement, FontWeight, IntoElement, MouseButton, ParentElement, SharedString, Styled, canvas,
    div, prelude::*,
};

use crate::content::toolbar::ink_for;
use crate::host::UiHost;
use crate::window::chrome::Chrome;
use crate::window::layout::ChromeLayout;

pub const STRIP_HEIGHT: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolbarMode {
    Shown,
    Collapsed,
}

pub struct ModeInput {
    pub enabled: bool,
    pub has_page: bool,
    pub scrolled_down: bool,
    pub needs_bar: bool,
}

pub fn toolbar_mode(input: &ModeInput) -> ToolbarMode {
    if !input.enabled || !input.has_page || !input.scrolled_down || input.needs_bar {
        ToolbarMode::Shown
    } else {
        ToolbarMode::Collapsed
    }
}

pub const GLIDE: std::time::Duration = std::time::Duration::from_millis(150);
pub const PEEK_DELAY: std::time::Duration = std::time::Duration::from_millis(150);
pub const UNPEEK_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Default)]
pub struct HideMotion {
    pub collapsed: bool,
    pub from: f32,
    pub start: Option<std::time::Instant>,
    pub hover_since: Option<std::time::Instant>,
    pub leave_at: Option<std::time::Instant>,
    pub peek: bool,
}

impl HideMotion {
    pub fn progress(&self, now: std::time::Instant) -> f32 {
        let to = if self.collapsed { 1.0 } else { 0.0 };
        match self.start {
            Some(at) => {
                let t = now.saturating_duration_since(at).as_secs_f32() / GLIDE.as_secs_f32();
                self.from + (to - self.from) * crate::content::load_fill::ease_enter(t)
            }
            None => to,
        }
    }

    pub fn set(&mut self, collapsed: bool, now: std::time::Instant, still: bool) {
        if collapsed == self.collapsed {
            return;
        }
        self.from = self.progress(now);
        self.collapsed = collapsed;
        self.start = (!still).then_some(now);
        if !collapsed {
            self.peek = false;
            self.hover_since = None;
            self.leave_at = None;
        }
    }

    pub fn tick(&mut self, now: std::time::Instant) {
        if let Some(at) = self.hover_since
            && self.collapsed
            && now.saturating_duration_since(at) >= PEEK_DELAY
        {
            if !self.peek {
                ardia_telemetry::counts::count("toolbar_peeks");
            }
            self.peek = true;
            self.hover_since = None;
        }
        if let Some(at) = self.leave_at
            && now.saturating_duration_since(at) >= UNPEEK_DELAY
        {
            self.peek = false;
            self.leave_at = None;
        }
    }

    pub fn running(&self, now: std::time::Instant) -> bool {
        self.start
            .is_some_and(|at| now.saturating_duration_since(at) < GLIDE)
            || self.hover_since.is_some()
            || self.leave_at.is_some()
    }
}

pub fn controls_fade(p: f32) -> f32 {
    let stops = [(0.0, 1.0), (0.2, 0.45), (0.4, 0.15), (0.6, 0.0), (1.0, 0.0)];
    crate::content::load_fill::stop_at(&stops, p)
}

pub fn label_fade(p: f32) -> f32 {
    crate::content::load_fill::stop_at(&[(0.0, 0.0), (0.5, 0.0), (1.0, 1.0)], p)
}

thread_local! {
    static SHOWN: RefCell<HashMap<WindowId, TabId>> = RefCell::new(HashMap::new());
    static MOTION: RefCell<HashMap<WindowId, HideMotion>> = RefCell::new(HashMap::new());
    static STILL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn with_motion<R>(window: &WindowId, f: impl FnOnce(&mut HideMotion) -> R) -> R {
    MOTION.with(|m| f(m.borrow_mut().entry(window.clone()).or_default()))
}

fn wants_collapse(state: &BrowserState, host: &Arc<dyn UiHost>, window: &WindowId) -> bool {
    let Some(tab) = state.active_tab(window.as_str()) else {
        return false;
    };
    let switched = SHOWN.with(|shown| {
        let mut shown = shown.borrow_mut();
        let before = shown.insert(window.clone(), tab.id.clone());
        before.as_ref() != Some(&tab.id)
    });
    if switched {
        host.reveal_toolbar(&tab.id);
        return false;
    }
    let held = state
        .window(window.as_str())
        .is_some_and(|w| w.chrome.popover.is_some())
        || tab.live.find.open;
    toolbar_mode(&ModeInput {
        enabled: state.settings.hide_toolbar_while_scrolling
            && state.split_of(tab.id.as_str()).is_none(),
        has_page: !tab.url.is_empty(),
        scrolled_down: host.scrolled_down(&tab.id),
        needs_bar: held,
    }) == ToolbarMode::Collapsed
}

pub fn toolbar_height(
    state: &BrowserState,
    host: &Arc<dyn UiHost>,
    window: &WindowId,
    layout: &ChromeLayout,
) -> Option<f32> {
    if layout.toolbar <= STRIP_HEIGHT {
        return None;
    }
    let collapse = wants_collapse(state, host, window);
    let now = std::time::Instant::now();
    let still = STILL.with(|s| s.get());
    let p = with_motion(window, |m| {
        m.set(collapse, now, still);
        m.tick(now);
        m.progress(now)
    });
    let height = layout.toolbar + (STRIP_HEIGHT - layout.toolbar) * p;
    (height < layout.toolbar - 0.25).then_some(height)
}

pub fn collapsed_bar(
    c: &Chrome,
    tab: &Arc<Tab>,
    width: f32,
    row_height: f32,
    full: AnyElement,
) -> AnyElement {
    let now = std::time::Instant::now();
    let (p, peek, running) =
        with_motion(&c.window.id, |m| (m.progress(now), m.peek, m.running(now)));
    let ink = ink_for(c, Some(tab));
    let host = Arc::clone(c.host);
    let reveal = tab.id.clone();
    let label = ardia_state::omnibox::url::breadcrumb_host(&tab.url);
    let height = c.layout.toolbar;
    let enter = c.window.id.clone();
    let leave = c.window.id.clone();
    let click_window = c.window.id.clone();
    let controls = if peek { 1.0 } else { controls_fade(p) };
    div()
        .id("toolbar-collapsed")
        .debug_selector(|| "toolbar-collapsed".into())
        .absolute()
        .left_0()
        .top_0()
        .w(px(width))
        .h(px(row_height))
        .child(
            canvas(
                move |_, window, cx| {
                    STILL.with(|s| s.set(cx.reduce_motion()));
                    if running {
                        window.request_animation_frame();
                    }
                },
                |_, _, _, _| {},
            )
            .absolute()
            .size_0(),
        )
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .w(px(width))
                .h(px(height))
                .when_some(ink.fill, |this, fill| this.bg(fill))
                .child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom_0()
                        .h(px(crate::content::toolbar::DIVIDER))
                        .bg(ink.divider),
                ),
        )
        .child(
            div()
                .id("toolbar-collapsed-label")
                .absolute()
                .left_0()
                .top_0()
                .w(px(width))
                .h(px(STRIP_HEIGHT))
                .px(px(ardia_theme::tokens::space::L))
                .flex()
                .items_center()
                .justify_center()
                .opacity(label_fade(p))
                .cursor_pointer()
                .on_hover(move |hovered, window, _| {
                    with_motion(&enter, |m| {
                        if *hovered && m.collapsed {
                            m.hover_since = Some(std::time::Instant::now());
                        } else {
                            m.hover_since = None;
                        }
                    });
                    window.refresh();
                })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(move |_, window, _| {
                    with_motion(&click_window, |m| m.hover_since = None);
                    host.reveal_toolbar(&reveal);
                    window.refresh();
                })
                .tooltip(crate::primitives::controls::tooltip(
                    "Show Toolbar".into(),
                    c.p,
                ))
                .child(
                    div()
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(ink.secondary)
                        .child(SharedString::from(label)),
                ),
        )
        .when(peek || p < 0.6, |this| {
            this.child(
                div()
                    .id("toolbar-peek")
                    .absolute()
                    .left_0()
                    .top_0()
                    .w(px(width))
                    .h(px(row_height))
                    .opacity(controls)
                    .when(peek, |this| {
                        this.when_some(ink.fill, |this, fill| this.bg(fill))
                    })
                    .on_hover(move |hovered, window, _| {
                        with_motion(&leave, |m| {
                            if !m.peek {
                                return;
                            }
                            m.leave_at = (!*hovered).then(std::time::Instant::now);
                        });
                        window.refresh();
                    })
                    .child(full),
            )
        })
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsing_glides_and_hover_peeks_after_a_beat() {
        let now = std::time::Instant::now();
        let mut m = HideMotion::default();
        m.set(true, now, false);
        assert_eq!(m.progress(now), 0.0);
        assert_eq!(m.progress(now + GLIDE), 1.0);
        assert!((controls_fade(0.2) - 0.45).abs() < 1e-6);
        assert_eq!(label_fade(0.5), 0.0);
        m.hover_since = Some(now);
        m.tick(now + PEEK_DELAY / 2);
        assert!(!m.peek);
        m.tick(now + PEEK_DELAY);
        assert!(m.peek);
        m.leave_at = Some(now);
        m.tick(now + UNPEEK_DELAY);
        assert!(!m.peek);
        m.set(false, now, true);
        assert_eq!(m.progress(now), 0.0);
    }

    #[test]
    fn the_toolbar_only_collapses_on_a_scrolled_page_nobody_needs_it_for() {
        let base = ModeInput {
            enabled: true,
            has_page: true,
            scrolled_down: true,
            needs_bar: false,
        };
        assert_eq!(toolbar_mode(&base), ToolbarMode::Collapsed);
        assert_eq!(
            toolbar_mode(&ModeInput {
                enabled: false,
                ..base
            }),
            ToolbarMode::Shown
        );
        assert_eq!(
            toolbar_mode(&ModeInput {
                has_page: false,
                ..base
            }),
            ToolbarMode::Shown
        );
        assert_eq!(
            toolbar_mode(&ModeInput {
                scrolled_down: false,
                ..base
            }),
            ToolbarMode::Shown
        );
        assert_eq!(
            toolbar_mode(&ModeInput {
                needs_bar: true,
                ..base
            }),
            ToolbarMode::Shown
        );
    }
}
