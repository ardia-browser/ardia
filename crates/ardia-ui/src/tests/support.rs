use std::sync::Arc;

use ardia_state::windows::WindowKind;
use ardia_state::{Action, BrowserState, NewTab, TabId, WindowId};
use gpui::{Bounds, Pixels, TestAppContext, VisualTestContext, WindowHandle};

use crate::mock::MockUiHost;
use crate::window::browser_window::BrowserWindowView;
use crate::{OpenWindowTarget, UiHost, bind_global_keybindings, open_browser_window};

pub const CLICK_REACH: std::time::Duration = std::time::Duration::from_millis(200);

pub struct Browser {
    pub host: Arc<MockUiHost>,
    pub window: WindowId,
    pub handle: WindowHandle<BrowserWindowView>,
}

impl Browser {
    pub fn open(cx: &mut TestAppContext) -> Browser {
        Self::open_with(cx, |_| {})
    }

    pub fn open_with(cx: &mut TestAppContext, prepare: impl FnOnce(&MockUiHost)) -> Browser {
        cx.update(bind_global_keybindings);
        let host = MockUiHost::fresh();
        let window = host
            .open_window(WindowKind::Main, Some("https://example.com/docs/start"))
            .expect("a window");
        prepare(&host);
        let shared: Arc<dyn UiHost> = host.clone();
        let handle = cx
            .update(|cx| {
                open_browser_window(
                    shared,
                    OpenWindowTarget {
                        window_id: window.clone(),
                        ..OpenWindowTarget::default()
                    },
                    cx,
                )
            })
            .expect("the window opens")
            .downcast::<BrowserWindowView>()
            .expect("a browser window");
        handle
            .update(cx, |_, window, _| window.activate_window())
            .expect("the window is open");
        cx.run_until_parked();
        Browser {
            host,
            window,
            handle,
        }
    }

    pub fn state(&self) -> Arc<BrowserState> {
        self.host.store().snapshot()
    }

    pub fn act(&self, cx: &mut TestAppContext, action: Action) {
        self.host.dispatch(action);
        cx.run_until_parked();
    }

    pub fn new_tab(&self, cx: &mut TestAppContext, url: &str) -> TabId {
        let outcome = self
            .host
            .store()
            .dispatch(Action::NewTab {
                window: self.window.clone(),
                tab: NewTab {
                    url: Some(url.to_owned()),
                    ..NewTab::default()
                },
            })
            .expect("a new tab");
        cx.run_until_parked();
        outcome.tab.expect("a tab id")
    }

    pub fn active(&self) -> TabId {
        self.state()
            .active_tab(self.window.as_str())
            .map(|t| t.id.clone())
            .expect("an active tab")
    }

    pub fn tab_count(&self) -> usize {
        self.state().view_tabs(self.window.as_str(), None).len()
    }

    pub fn keys(&self, cx: &mut TestAppContext, keys: &str) {
        cx.simulate_keystrokes(self.handle.into(), keys);
        cx.run_until_parked();
    }

    pub fn typed(&self, cx: &mut TestAppContext, text: &str) {
        cx.simulate_input(self.handle.into(), text);
        cx.run_until_parked();
    }

    pub fn view<R>(
        &self,
        cx: &mut TestAppContext,
        read: impl FnOnce(&BrowserWindowView) -> R,
    ) -> R {
        self.handle
            .read_with(cx, |view, _| read(view))
            .expect("the window is open")
    }

    pub fn bounds(
        &self,
        cx: &mut TestAppContext,
        selector: &'static str,
    ) -> Option<Bounds<Pixels>> {
        let mut visual = VisualTestContext::from_window(self.handle.into(), cx);
        visual.run_until_parked();
        visual.debug_bounds(selector)
    }

    pub fn open_peek_fully(&self, cx: &mut TestAppContext) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while self.view(cx, |view| view.peek_motion.motion().phase())
            != crate::content::peek_motion::PeekPhase::Open
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(8));
            self.handle
                .update(cx, |_, window, _| window.refresh())
                .expect("open");
            self.bounds(cx, "peek-overlay");
        }
    }

    pub fn settle_rows(&self, cx: &mut TestAppContext) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut last = self.bounds(cx, "new-tab-row");
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(16));
            self.handle
                .update(cx, |_, window, _| window.refresh())
                .expect("open");
            let now = self.bounds(cx, "new-tab-row");
            if now == last {
                return;
            }
            last = now;
        }
    }

    pub fn settle_peek(&self, cx: &mut TestAppContext) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while self.bounds(cx, "peek-overlay").is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(8));
            self.handle
                .update(cx, |_, window, _| window.refresh())
                .expect("open");
        }
    }

    pub fn click(&self, cx: &mut TestAppContext, selector: &'static str) {
        cx.executor().advance_clock(CLICK_REACH);
        self.redraw(cx);
        let bounds = self
            .bounds(cx, selector)
            .unwrap_or_else(|| panic!("{selector} is on screen"));
        let mut visual = VisualTestContext::from_window(self.handle.into(), cx);
        visual.simulate_click(bounds.center(), gpui::Modifiers::none());
        visual.run_until_parked();
    }

    pub fn redraw(&self, cx: &mut TestAppContext) {
        self.handle
            .update(cx, |_, window, cx| {
                window.refresh();
                cx.notify();
            })
            .expect("the window is open");
        cx.run_until_parked();
    }
}
