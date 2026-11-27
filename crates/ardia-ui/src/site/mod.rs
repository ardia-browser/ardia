pub mod controls;
pub mod menus;
pub mod model;
pub mod parts;
pub mod prompts;
pub mod render;
pub mod selection;

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use ardia_state::TabId;
use ardia_state::windows::Popover;
use gpui::{Context, Task, Window};

use crate::msg::Msg;
use crate::window::browser_window::BrowserWindowView;

pub use model::{SiteAnswer, SitePage, SitePanel};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Expanded {
    #[default]
    None,
    Connection,
    More,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SiteMsg {
    Answer(TabId, SiteAnswer),
    Guarded { key: String, then: Vec<Msg> },
    ChooseUsername { key: String, name: String },
    ExternalAlways { id: String, on: bool },
    SelectDevice { chooser: i32, index: usize },
    OfferRemember(bool),
    Expand(Expanded),
    ZoomHover(bool),
    ZoomChanged,
    SelectionChanged,
    OpenIn(TabId, Option<ardia_state::model::PageEngine>),
    TogglePageEngine(TabId),
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PageAnchor {
    pub url_left: Option<f32>,
    pub sidebar_right: bool,
}

pub const PAGE_MARGIN: f32 = ardia_theme::tokens::space::M;

pub fn fit_left(want: f32, room: f32, width: f32) -> f32 {
    want.min(room - width - PAGE_MARGIN).max(PAGE_MARGIN)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageSurface {
    Prompt,
    SiteButton,
}

pub fn page_surface_left(anchor: PageAnchor, surface: PageSurface, pane: f32, width: f32) -> f32 {
    let want = match (anchor.url_left, surface) {
        (None, _) if anchor.sidebar_right => f32::INFINITY,
        (None, _) => f32::NEG_INFINITY,
        (Some(_), PageSurface::SiteButton) => f32::INFINITY,
        (Some(left), PageSurface::Prompt) => left,
    };
    fit_left(want, pane, width)
}

#[derive(Default)]
pub struct SiteUi {
    expanded: RefCell<Option<(TabId, Expanded)>>,
    pub chosen_username: Option<(String, String)>,
    pub external_always: Option<(String, bool)>,
    pub device_selected: Option<(i32, usize)>,
    pub offer_remember: bool,
    pub zoom_bubble: bool,
    pub zoom_hovered: bool,
    pub selection_shown: Option<(TabId, model::PageSelection)>,
    seen: RefCell<HashMap<String, Instant>>,
    refreshed: RefCell<Option<TabId>>,
    featured: RefCell<Option<(TabId, Vec<&'static str>)>>,
    last_input: Option<Instant>,
    zoom_timer: Option<Task<()>>,
    selection_timer: Option<Task<()>>,
    born: Option<Instant>,
    guarded: bool,
}

impl SiteUi {
    pub fn new() -> Self {
        SiteUi::guarded(!cfg!(test))
    }

    pub fn guarded(guarded: bool) -> Self {
        SiteUi {
            born: Some(Instant::now()),
            guarded,
            ..SiteUi::default()
        }
    }

    pub fn note_visible(&self, key: &str) {
        let mut seen = self.seen.borrow_mut();
        if !seen.contains_key(key) {
            if seen.len() > 64 {
                seen.clear();
            }
            seen.insert(key.to_owned(), Instant::now());
        }
    }

    pub fn note_panel_open(&self, tab: &TabId) -> bool {
        let mut refreshed = self.refreshed.borrow_mut();
        if refreshed.as_ref() == Some(tab) {
            return false;
        }
        *refreshed = Some(tab.clone());
        true
    }

    pub fn note_panel_closed(&self) {
        self.refreshed.borrow_mut().take();
        self.featured.borrow_mut().take();
        self.expanded.borrow_mut().take();
    }

    pub fn featured(
        &self,
        tab: &TabId,
        first: impl FnOnce() -> Option<Vec<&'static str>>,
    ) -> Vec<&'static str> {
        let mut featured = self.featured.borrow_mut();
        if let Some((known, list)) = featured.as_ref()
            && known == tab
        {
            return list.clone();
        }
        match first() {
            Some(list) => {
                *featured = Some((tab.clone(), list.clone()));
                list
            }
            None => Vec::new(),
        }
    }

    pub fn expanded_for(&self, tab: &TabId) -> Expanded {
        if let Some((known, section)) = self.expanded.borrow().as_ref()
            && known == tab
        {
            *section
        } else {
            Expanded::None
        }
    }

    pub fn chosen_username(&self, key: &str) -> Option<&str> {
        self.chosen_username
            .as_ref()
            .filter(|(known, _)| known == key)
            .map(|(_, name)| name.as_str())
    }

    pub fn external_always(&self, id: &str) -> bool {
        self.external_always
            .as_ref()
            .is_some_and(|(known, on)| known == id && *on)
    }

    pub fn device_selected(&self, chooser: i32) -> Option<usize> {
        self.device_selected
            .filter(|(known, _)| *known == chooser)
            .map(|(_, index)| index)
    }

    fn millis(&self, at: Instant) -> u64 {
        let born = self.born.unwrap_or(at);
        at.saturating_duration_since(born).as_millis() as u64
    }

    pub fn input_allowed(&mut self, key: &str, now: Instant) -> bool {
        const OFFSET: u64 = 10_000;
        let visible = self.seen.borrow().get(key).copied();
        let previous = self.last_input.map_or(0, |at| self.millis(at) + OFFSET);
        self.last_input = Some(now);
        if !self.guarded {
            return true;
        }
        let Some(visible) = visible else {
            return false;
        };
        let appear = crate::primitives::tokens::duration::BASE.as_millis() as u64;
        model::prompt_input_allowed(
            self.millis(visible) + OFFSET + appear,
            0,
            previous,
            self.millis(now) + OFFSET,
        )
    }
}

impl BrowserWindowView {
    pub(crate) fn site_msg(&mut self, msg: SiteMsg, window: &mut Window, cx: &mut Context<Self>) {
        match msg {
            SiteMsg::Answer(tab, answer) => {
                self.site_answer(tab, answer, window, cx);
            }
            SiteMsg::Guarded { key, then } => {
                if self.site.input_allowed(&key, Instant::now()) {
                    for msg in then {
                        self.handle(msg, window, cx);
                    }
                }
            }
            SiteMsg::ChooseUsername { key, name } => {
                self.site.chosen_username = Some((key, name));
            }
            SiteMsg::ExternalAlways { id, on } => {
                if self
                    .site
                    .input_allowed(&format!("external:{id}"), Instant::now())
                {
                    self.site.external_always = Some((id, on));
                }
            }
            SiteMsg::SelectDevice { chooser, index } => {
                self.site.device_selected = Some((chooser, index));
            }
            SiteMsg::OfferRemember(on) => self.site.offer_remember = on,
            SiteMsg::OpenIn(tab, Some(engine)) => self.host.open_page_in(tab, engine),
            SiteMsg::OpenIn(tab, None) => self.host.reset_page_engine(tab),
            SiteMsg::TogglePageEngine(tab) => self.host.toggle_page_engine(tab),
            SiteMsg::Expand(section) => {
                let tab = self.active_tab().map(|t| t.id.clone());
                let current = tab
                    .as_ref()
                    .map_or(Expanded::None, |tab| self.site.expanded_for(tab));
                let next = if current == section {
                    Expanded::None
                } else {
                    section
                };
                *self.site.expanded.borrow_mut() = tab.map(|tab| (tab, next));
            }
            SiteMsg::ZoomHover(over) => {
                self.site.zoom_hovered = over;
                if over {
                    self.site.zoom_timer = None;
                } else if self.site.zoom_bubble {
                    self.start_zoom_timer(window, cx);
                }
            }
            SiteMsg::ZoomChanged => self.zoom_changed_by_user(window, cx),
            SiteMsg::SelectionChanged => self.selection_changed(cx),
        }
        cx.notify();
    }

    fn site_answer(
        &mut self,
        tab: TabId,
        answer: SiteAnswer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match &answer {
            SiteAnswer::ExternalApp { .. } => self.site.external_always = None,
            SiteAnswer::ChooseDevice { .. } | SiteAnswer::CancelDevice(_) => {
                self.site.device_selected = None
            }
            SiteAnswer::EngineOffer { .. } => self.site.offer_remember = false,
            SiteAnswer::SearchSelection {
                text,
                platform,
                shift,
                alt,
            } => {
                self.site.selection_shown = None;
                self.site.selection_timer = None;
                let query = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if query.is_empty() {
                    return;
                }
                let url = self.state.default_search_engine().search_url(&query);
                let mode = selection_open_mode(*platform, *shift, *alt);
                crate::pages::bookmarks::open::open_url(&self.host, &self.window_id, &url, mode);
                return;
            }
            SiteAnswer::DismissSelection => {
                self.site.selection_shown = None;
                self.site.selection_timer = None;
            }
            SiteAnswer::Popups(_) => self.close_site_popover(&Popover::BlockedPopups, window, cx),
            _ => {}
        }
        self.host.site_answer(tab, answer);
    }

    fn close_site_popover(
        &mut self,
        popover: &Popover,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let open = self
            .state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.popover.clone());
        if open.as_ref() == Some(popover) {
            self.dispatch(
                ardia_state::Action::SetPopover {
                    window: self.window_id.clone(),
                    popover: None,
                },
                window,
                cx,
            );
        }
    }

    fn zoom_changed_by_user(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self
            .state
            .window(self.window_id.as_str())
            .and_then(|w| w.chrome.popover.clone());
        match open {
            None => {
                self.site.zoom_bubble = true;
                self.dispatch(
                    ardia_state::Action::SetPopover {
                        window: self.window_id.clone(),
                        popover: Some(Popover::Zoom),
                    },
                    window,
                    cx,
                );
            }
            Some(Popover::Zoom) if self.site.zoom_bubble => {}
            Some(_) => return,
        }
        self.start_zoom_timer(window, cx);
    }

    fn start_zoom_timer(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.site.zoom_hovered {
            self.site.zoom_timer = None;
            return;
        }
        self.site.zoom_timer = Some(cx.spawn_in(_window, async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(model::ZOOM_BUBBLE_CLOSE_MS))
                .await;
            let _ = view.update_in(cx, |view, window, cx| {
                view.site.zoom_timer = None;
                if !view.site.zoom_bubble {
                    return;
                }
                view.site.zoom_bubble = false;
                view.close_site_popover(&Popover::Zoom, window, cx);
                cx.notify();
            });
        }));
    }

    pub(crate) fn site_popover_toggled(&mut self, popover: &Popover) {
        if *popover == Popover::Zoom {
            self.site.zoom_bubble = false;
            self.site.zoom_timer = None;
        }
        if *popover == Popover::SiteControls {
            self.site.note_panel_closed();
        }
    }

    pub(crate) fn selection_changed(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.active_tab().map(|t| t.id.clone()) else {
            return;
        };
        let current = if self.state.settings.show_selection_search {
            self.host.page_selection(&tab)
        } else {
            None
        };
        let Some(selection) = current else {
            self.site.selection_shown = None;
            self.site.selection_timer = None;
            return;
        };
        if self
            .site
            .selection_shown
            .as_ref()
            .is_some_and(|(known, shown)| *known == tab && *shown == selection)
        {
            return;
        }
        self.site.selection_timer = Some(cx.spawn(async move |view, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(model::SELECTION_SHOW_DELAY_MS))
                .await;
            let _ = view.update(cx, |view, cx| {
                view.site.selection_timer = None;
                view.site.selection_shown = Some((tab, selection));
                cx.notify();
            });
        }));
    }
}

pub fn selection_open_mode(
    platform: bool,
    shift: bool,
    alt: bool,
) -> crate::pages::bookmarks::open::OpenMode {
    use crate::pages::bookmarks::open::OpenMode;
    if platform {
        return if shift {
            OpenMode::Foreground
        } else {
            OpenMode::Background
        };
    }
    if alt {
        OpenMode::Split
    } else if shift {
        OpenMode::Window
    } else {
        OpenMode::Foreground
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_surfaces_hug_the_url_field_or_the_sidebar_edge() {
        let anchor = PageAnchor {
            url_left: Some(120.0),
            sidebar_right: false,
        };
        assert_eq!(
            page_surface_left(anchor, PageSurface::Prompt, 900.0, 300.0),
            120.0
        );
        assert_eq!(
            page_surface_left(anchor, PageSurface::SiteButton, 900.0, 300.0),
            900.0 - 300.0 - PAGE_MARGIN
        );
        let bare = PageAnchor::default();
        assert_eq!(
            page_surface_left(bare, PageSurface::Prompt, 900.0, 300.0),
            PAGE_MARGIN
        );
        let right = PageAnchor {
            url_left: None,
            sidebar_right: true,
        };
        assert_eq!(
            page_surface_left(right, PageSurface::Prompt, 900.0, 300.0),
            900.0 - 300.0 - PAGE_MARGIN
        );
        assert_eq!(fit_left(500.0, 400.0, 300.0), 92.0);
        assert_eq!(fit_left(500.0, 200.0, 300.0), PAGE_MARGIN);
    }

    #[test]
    fn prompt_input_waits_for_the_prompt_to_settle() {
        let mut ui = SiteUi::guarded(true);
        let start = Instant::now();
        assert!(!ui.input_allowed("a", start));
        ui.note_visible("a");
        assert!(!ui.input_allowed("a", Instant::now()));
        let later = Instant::now() + Duration::from_millis(1300);
        assert!(ui.input_allowed("a", later));
        assert!(!ui.input_allowed("a", later + Duration::from_millis(100)));
    }
}
