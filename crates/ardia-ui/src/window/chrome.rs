use std::sync::Arc;

use crate::scale::px;
use ardia_state::tabs::Tab;
use ardia_state::windows::BrowserWindow;
use ardia_state::{BrowserState, TabId};
use gpui::{
    Context, Entity, FontWeight, Hsla, IntoElement, ParentElement, Pixels, Point, Render,
    SharedString, Styled, Window, div, prelude::*,
};

use crate::host::UiHost;
use crate::look::{Look, Palette};
use crate::msg::{Emit, MenuTarget, RenameTarget};
use crate::primitives::favicon::{Favicon, favicon_of, render_favicon, resolve_favicon};
use crate::primitives::text_input::TextInput;
use crate::sidebar::model::Sections;
use crate::window::layout::ChromeLayout;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChromeUi {
    pub menu: Option<(MenuTarget, Point<Pixels>)>,
    pub rename: Option<RenameTarget>,
    pub url_hover: bool,
    pub edge: bool,
    pub peek_hover: bool,
    pub sidebar_drag: Option<f32>,
    pub profile_offset: f32,
    pub profile_alpha: f32,
    pub toast_hold: crate::popovers::toast::ToastHold,
}

pub struct Chrome<'a> {
    pub state: &'a BrowserState,
    pub window: &'a BrowserWindow,
    pub look: &'a Look,
    pub p: &'a Palette,
    pub layout: &'a ChromeLayout,
    pub emit: &'a Emit,
    pub host: &'a Arc<dyn UiHost>,
    pub ui: &'a ChromeUi,
    pub active: Option<&'a Arc<Tab>>,
    pub rename_input: &'a Entity<TextInput>,
    pub sections: &'a Sections,
    pub toast_focus: Option<&'a [gpui::FocusHandle; 2]>,
}

impl Chrome<'_> {
    pub fn is_active(&self, tab: &TabId) -> bool {
        self.active.is_some_and(|active| &active.id == tab)
    }

    pub fn is_selected(&self, tab: &TabId) -> bool {
        self.window.chrome.selection.contains(tab)
    }

    pub fn renaming_tab(&self, tab: &TabId) -> bool {
        matches!(&self.ui.rename, Some(RenameTarget::Tab(id)) if id == tab)
    }

    pub fn favicon(&self, tab: &Tab) -> Favicon {
        let favicon = favicon_of(
            &tab.url,
            tab.favicon.as_deref(),
            tab.custom_icon.as_deref(),
            &tab.label(),
        );
        crate::primitives::favicon::resolve_tab_favicon(
            favicon,
            &tab.url,
            tab.live.engine_tab_id.is_some(),
            self.host.as_ref(),
            &tab.profile_id,
        )
    }

    pub fn resolve_favicon(&self, favicon: Favicon, profile: &ardia_state::ProfileId) -> Favicon {
        resolve_favicon(favicon, self.host.as_ref(), profile)
    }

    pub fn points(&self, value: f32) -> f32 {
        self.look.points(value)
    }
}

pub fn tab_title(tab: &Tab) -> SharedString {
    SharedString::from(tab.display_title())
}

#[derive(Clone, Debug, PartialEq)]
pub struct TabDrag {
    pub tab: TabId,
    pub title: SharedString,
    pub favicon: Favicon,
    pub p: Palette,
}

pub struct TabDragGhost {
    drag: TabDrag,
}

impl TabDragGhost {
    pub fn new(drag: TabDrag) -> Self {
        TabDragGhost { drag }
    }
}

impl Render for TabDragGhost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let p = &self.drag.p;
        div()
            .w(px(200.))
            .h(px(34.))
            .px(px(9.))
            .rounded(px(10.))
            .bg(Hsla::white().opacity(0.15))
            .border(px(0.5))
            .border_color(p.tab_selected_border)
            .flex()
            .items_center()
            .gap(px(7.))
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(p.text)
            .child(render_favicon(&self.drag.favicon, 16., p))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(self.drag.title.clone()),
            )
    }
}

pub struct TabHoverCard {
    title: SharedString,
    away: Option<crate::sidebar::away_title::AwayTitle>,
    address: String,
    full_url: bool,
    sleeping: bool,
    favicon: Favicon,
    icon_side: f32,
    p: Palette,
}

impl TabHoverCard {
    pub fn new(tab: &Tab, favicon: Favicon, icon_side: f32, full_url: bool, p: &Palette) -> Self {
        TabHoverCard {
            title: tab_title(tab),
            away: crate::sidebar::away_title::away_title(tab),
            address: crate::sidebar::hover_card::card_address(&tab.url, full_url),
            full_url,
            sleeping: tab.page.is_asleep(),
            favicon,
            icon_side,
            p: *p,
        }
    }
}

impl TabHoverCard {
    pub fn body(&self) -> gpui::Div {
        use crate::sidebar::hover_card::{HEADER, PAD, WIDTH};
        use crate::sidebar::row_look::SPACE_XS;
        let p = &self.p;
        let full_url = self.full_url;
        crate::primitives::controls::hover_card(WIDTH, p)
            .debug_selector(|| "strip-hover-card".into())
            .p(px(PAD))
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(HEADER))
                    .flex()
                    .items_center()
                    .gap(px(crate::sidebar::tab_row::TITLE_GAP))
                    .child(render_favicon(&self.favicon, self.icon_side, p))
                    .child(match &self.away {
                        Some(away) => crate::sidebar::away_title::away_label(
                            away,
                            crate::sidebar::away_title::AwayLabel {
                                color: p.text,
                                size: 13.,
                                weight: FontWeight::MEDIUM,
                                height: 18.,
                                struck: false,
                                max_width: WIDTH - 2.0 * PAD - self.icon_side,
                            },
                        ),
                        None => crate::primitives::fade_label::fade_label(
                            self.title.clone(),
                            p.text,
                            13.,
                        )
                        .weight(FontWeight::MEDIUM)
                        .line_height(18.)
                        .into_any_element(),
                    }),
            )
            .when(!self.address.is_empty(), |this| {
                this.child(
                    div()
                        .mt(px(SPACE_XS))
                        .text_size(px(11.))
                        .line_height(px(14.))
                        .text_color(p.text_secondary)
                        .when(full_url, |d| d.line_clamp(2))
                        .when(!full_url, |d| d.truncate())
                        .child(self.address.clone()),
                )
            })
            .when(self.sleeping, |this| {
                this.child(
                    div()
                        .mt(px(SPACE_XS))
                        .flex()
                        .items_center()
                        .gap(px(SPACE_XS))
                        .child(
                            div()
                                .size(px(14.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(crate::primitives::icons::icon(
                                    crate::primitives::icons::Icon::MoonZzz,
                                    10.,
                                    p.text_tertiary,
                                )),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(p.text_tertiary)
                                .child("This tab needs to reload"),
                        ),
                )
            })
    }
}
