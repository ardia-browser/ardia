use ardia_state::tabs::Tab;
use ardia_state::windows::Popover;
use gpui::{
    AnyElement, InteractiveElement, IntoElement, ParentElement, Styled, deferred, div,
    prelude::FluentBuilder,
};

use crate::site::controls::{
    hidden_elements_panel, site_button_place, site_controls_panel, zoom_panel,
};
use crate::site::model::SitePage;
use crate::site::parts::{HIDDEN_ELEMENTS_WIDTH, SITE_PANEL_WIDTH, ZOOM_WIDTH};
use crate::site::prompts::{PromptPlace, blocked_popups_prompt, page_prompts};
use crate::site::selection::selection_popover;
use crate::site::{PageAnchor, SiteUi};
use crate::window::chrome::Chrome;
use crate::window::layout::Rect;

pub const HIDDEN_ELEMENTS_POPOVER: &str = "hiddenElements";

pub fn page_anchor(c: &Chrome, sidebar_toggle: bool) -> PageAnchor {
    let has_toolbar = c.layout.toolbar > 0.0 && !c.layout.sidebar_shows_address();
    let page = c.layout.page();
    PageAnchor {
        url_left: has_toolbar.then(|| {
            c.layout.card.x + crate::content::toolbar::breadcrumb_x(sidebar_toggle)
                - crate::content::toolbar::FIELD_TEXT_LEFT
                - page.x
        }),
        sidebar_right: c.layout.trailing,
    }
}

pub fn site_page_of(c: &Chrome, tab: &Tab) -> SitePage {
    c.host
        .site_page(&tab.id)
        .unwrap_or_else(|| SitePage::from_prompts(tab))
}

pub fn page_layer(
    c: &Chrome,
    ui: &SiteUi,
    page: Rect,
    tab: &Tab,
    sidebar_toggle: bool,
    new_tab_shown: bool,
) -> Option<AnyElement> {
    let place = PromptPlace {
        page,
        anchor: page_anchor(c, sidebar_toggle),
        new_tab_shown,
    };
    let panel_open = c.window.chrome.popover.as_ref().is_some_and(|popover| {
        *popover == Popover::SiteControls
            || matches!(popover, Popover::Custom(name) if name == HIDDEN_ELEMENTS_POPOVER)
    });
    if !panel_open {
        ui.note_panel_closed();
    }
    let data = site_page_of(c, tab);
    let prompts = page_prompts(c, ui, &place, tab, &data);
    let selection = selection_popover(c, &tab.id, tab.zoom, page, ui.selection_shown.as_ref());
    if prompts.is_none() && selection.is_none() {
        return None;
    }
    Some(
        div()
            .absolute()
            .size_full()
            .children(prompts)
            .children(selection)
            .into_any_element(),
    )
}

pub fn popover_layer(
    c: &Chrome,
    ui: &SiteUi,
    page: Rect,
    tab: &Tab,
    popover: &Popover,
    sidebar_toggle: bool,
    exit: f32,
) -> Option<AnyElement> {
    let place = PromptPlace {
        page,
        anchor: page_anchor(c, sidebar_toggle),
        new_tab_shown: false,
    };
    let at = |width: f32| site_button_place(&place, width);
    let origin = |width: f32| {
        let placed = at(width);
        (
            placed.left + if placed.from_right { width } else { 0.0 },
            placed.top,
        )
    };
    let corner = match popover {
        Popover::SiteControls => Some(origin(SITE_PANEL_WIDTH)),
        Popover::Zoom => Some(origin(ZOOM_WIDTH)),
        Popover::Custom(name) if name == HIDDEN_ELEMENTS_POPOVER => {
            Some(origin(HIDDEN_ELEMENTS_WIDTH))
        }
        _ => None,
    };
    let element = match popover {
        Popover::SiteControls => {
            if ui.note_panel_open(&tab.id) {
                c.host.refresh_site_panel(tab.id.clone());
            }
            let data = c.host.site_panel(&tab.id);
            site_controls_panel(c, ui, tab, &data, at(SITE_PANEL_WIDTH))
        }
        Popover::Zoom => zoom_panel(c, ui, tab, at(ZOOM_WIDTH)),
        Popover::BlockedPopups => {
            let data = site_page_of(c, tab);
            blocked_popups_prompt(c, &place, &tab.id, &data.popups)?
        }
        Popover::Custom(name) if name == HIDDEN_ELEMENTS_POPOVER => {
            if ui.note_panel_open(&tab.id) {
                c.host.refresh_site_panel(tab.id.clone());
            }
            let data = c.host.site_panel(&tab.id);
            hidden_elements_panel(c, tab, &data, at(HIDDEN_ELEMENTS_WIDTH))
        }
        _ => return None,
    };
    let element = match corner {
        Some(corner) => closing_pose(c, element, corner, exit),
        None => element,
    };
    Some(deferred(element).with_priority(2).into_any_element())
}

pub fn fades_when_closed(popover: &Popover) -> bool {
    match popover {
        Popover::SiteControls | Popover::Zoom => true,
        Popover::Custom(name) => name == HIDDEN_ELEMENTS_POPOVER,
        _ => false,
    }
}

fn closing_pose(c: &Chrome, element: AnyElement, corner: (f32, f32), exit: f32) -> AnyElement {
    let pose = crate::primitives::appear::pose(
        crate::primitives::appear::Rise::popover(crate::primitives::appear::OriginX::Left, false),
        exit,
        None,
    );
    let centre = (c.layout.width / 2.0, c.layout.height / 2.0);
    let shift = |at: f32, mid: f32| (1.0 - pose.scale) * (at - mid);
    gpui::div()
        .id("site-panel-pose")
        .absolute()
        .left(crate::scale::px(shift(corner.0, centre.0)))
        .top(crate::scale::px(shift(corner.1, centre.1) + pose.dy))
        .size_full()
        .when(exit < 1.0, |this| {
            this.opacity(pose.opacity).scale(pose.scale)
        })
        .child(element)
        .into_any_element()
}

pub fn closes_on_outside_press(popover: &Popover, zoom_bubble: bool) -> bool {
    match popover {
        Popover::SiteControls | Popover::BlockedPopups => true,
        Popover::Zoom => !zoom_bubble,
        Popover::Custom(name) => name == HIDDEN_ELEMENTS_POPOVER,
        _ => false,
    }
}
