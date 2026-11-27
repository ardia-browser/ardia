use std::cell::RefCell;
use std::collections::HashMap;

use ardia_engine::{EngineTabId, NativeView};
use ardia_state::TabId;
use ardia_state::model::PageEngine;
use ardia_ui::host::RetiringPage;
use parking_lot::Mutex;

use super::{page, swap};
use crate::coordinator::AppCoordinator;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retired {
    Webkit,
    Chromium(EngineTabId),
}

impl Retired {
    pub fn engine(self) -> PageEngine {
        match self {
            Retired::Webkit => PageEngine::Webkit,
            Retired::Chromium(_) => PageEngine::Chromium,
        }
    }

    pub fn shown_above(self) -> bool {
        self.engine() != PageEngine::Chromium
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    Kept(Retired),
    LeftUnpainted,
    NotHeld,
}

pub fn hold_decision(
    swapping: bool,
    on_screen: bool,
    already_retiring: bool,
    live: Option<Retired>,
) -> Hold {
    if already_retiring {
        return Hold::LeftUnpainted;
    }
    match live {
        Some(retired) if swapping && on_screen => Hold::Kept(retired),
        _ => Hold::NotHeld,
    }
}

pub fn web_view_visible(url: &str, new_tab_shown: bool) -> bool {
    !new_tab_shown && !url.is_empty() && !url.to_ascii_lowercase().starts_with("ardia://newtab")
}

static RETIRED: Mutex<Option<HashMap<TabId, Retired>>> = Mutex::new(None);

thread_local! {
    static CHROMIUM_VIEWS: RefCell<HashMap<TabId, NativeView>> = RefCell::new(HashMap::new());
}

fn with_retired<T>(run: impl FnOnce(&mut HashMap<TabId, Retired>) -> T) -> T {
    let mut guard = RETIRED.lock();
    run(guard.get_or_insert_with(HashMap::new))
}

pub fn retired_of(tab: &TabId) -> Option<Retired> {
    with_retired(|retired| retired.get(tab).copied())
}

pub fn retired_tabs() -> Vec<TabId> {
    with_retired(|retired| retired.keys().cloned().collect())
}

pub fn is_retired_engine_tab(engine_tab: EngineTabId) -> bool {
    with_retired(|retired| {
        retired
            .values()
            .any(|r| *r == Retired::Chromium(engine_tab))
    })
}

impl AppCoordinator {
    pub(crate) fn retire_for_swap(&self, tab: &TabId) {
        let live = if page::has(tab) {
            Some(Retired::Webkit)
        } else {
            self.engine_tab(tab).map(Retired::Chromium)
        };
        let decision = hold_decision(
            swap::swapping(tab),
            self.retiring_visible(tab),
            retired_of(tab).is_some(),
            live,
        );
        if let Hold::Kept(retired) = decision {
            log::debug!("{tab} keeps its old {:?} page on screen", retired.engine());
        }
        match decision {
            Hold::LeftUnpainted => self.release_retiring(tab),
            Hold::NotHeld => {}
            Hold::Kept(Retired::Webkit) => {
                self.forget_webkit_page(tab);
                if page::hold_retiring(tab).is_some() {
                    with_retired(|retired| retired.insert(tab.clone(), Retired::Webkit));
                }
            }
            Hold::Kept(Retired::Chromium(engine_tab)) => {
                let view = self
                    .side()
                    .and_then(|side| side.borrow_mut().views.remove(&engine_tab))
                    .or_else(|| {
                        self.engine()
                            .and_then(|engine| engine.native_view_handle(engine_tab).ok())
                    });
                self.unbind_tab(tab);
                if let Some(view) = view {
                    CHROMIUM_VIEWS.with(|views| views.borrow_mut().insert(tab.clone(), view));
                }
                with_retired(|retired| retired.insert(tab.clone(), Retired::Chromium(engine_tab)));
            }
        }
        self.mark_dirty();
    }

    pub(crate) fn release_retiring(&self, tab: &TabId) {
        let Some(retired) = with_retired(|retired| retired.remove(tab)) else {
            return;
        };
        log::debug!("{tab} lets its old {:?} page go", retired.engine());
        match retired {
            Retired::Webkit => page::release_retiring(tab),
            Retired::Chromium(engine_tab) => {
                let view = CHROMIUM_VIEWS.with(|views| views.borrow_mut().remove(tab));
                drop(view);
                if let Some(engine) = self.engine() {
                    self.bridge.lock().closing_tabs.insert(engine_tab);
                    if let Err(problem) = engine.close(engine_tab)
                        && !problem.is_gone()
                    {
                        log::warn!("{tab}'s retired page didn't close: {problem}");
                    }
                }
            }
        }
        if let Some(listed) = self.store().snapshot().tab(tab.as_str()) {
            self.touch(listed.window_id.clone());
        }
        self.mark_dirty();
    }

    pub(crate) fn retiring_visible(&self, tab: &TabId) -> bool {
        let new_tab_shown = self.bridge.lock().new_tab_shown.contains_key(tab);
        let url = self
            .store()
            .snapshot()
            .tab(tab.as_str())
            .map(|listed| listed.url.clone())
            .unwrap_or_default();
        self.tab_on_screen(tab) && web_view_visible(&url, new_tab_shown)
    }

    pub(crate) fn settle_retiring(&self) {
        for tab in retired_tabs() {
            let gone = self.store().snapshot().tab(tab.as_str()).is_none();
            if gone || !swap::swapping(&tab) || !self.retiring_visible(&tab) {
                self.release_retiring(&tab);
            }
        }
    }

    pub fn retiring_page_of(&self, tab: &TabId) -> Option<RetiringPage> {
        let retired = retired_of(tab)?;
        let view = match retired {
            Retired::Webkit => page::retiring_view(tab)?,
            Retired::Chromium(_) => {
                CHROMIUM_VIEWS.with(|views| views.borrow().get(tab).map(NativeView::handle))?
            }
        };
        Some(RetiringPage {
            view,
            above: retired.shown_above(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hold_ends_where_the_old_app_hid_the_web_view() {
        assert!(web_view_visible("https://example.com/", false));
        assert!(web_view_visible("ardia://history", false));
        assert!(!web_view_visible("https://example.com/", true));
        assert!(!web_view_visible("", false));
        assert!(!web_view_visible("ARDIA://newtab", false));
    }

    #[test]
    fn a_visible_swap_keeps_the_old_page_like_the_old_app() {
        let engine_tab = EngineTabId::from_raw(7).expect("tab id");
        assert_eq!(
            hold_decision(true, true, false, Some(Retired::Webkit)),
            Hold::Kept(Retired::Webkit)
        );
        assert_eq!(
            hold_decision(true, true, false, Some(Retired::Chromium(engine_tab))),
            Hold::Kept(Retired::Chromium(engine_tab))
        );
        assert_eq!(
            hold_decision(true, false, false, Some(Retired::Webkit)),
            Hold::NotHeld
        );
        assert_eq!(
            hold_decision(false, true, false, Some(Retired::Webkit)),
            Hold::NotHeld
        );
        assert_eq!(hold_decision(true, true, false, None), Hold::NotHeld);
        assert_eq!(
            hold_decision(true, true, true, Some(Retired::Webkit)),
            Hold::LeftUnpainted
        );
    }

    #[test]
    fn an_old_webkit_page_sits_above_and_an_old_chromium_page_below() {
        assert!(Retired::Webkit.shown_above());
        assert!(!Retired::Chromium(EngineTabId::from_raw(7).expect("tab id")).shown_above());
        assert_eq!(Retired::Webkit.engine(), PageEngine::Webkit);
    }
}
