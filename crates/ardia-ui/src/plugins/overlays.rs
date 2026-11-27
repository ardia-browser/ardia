use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use ardia_state::WindowId;
use ardia_theme::tokens::{TypeSize, space};
use gpui::{
    AnyElement, App, Context, Entity, FontWeight, IntoElement, KeyDownEvent, MouseButton,
    ParentElement, Render, SharedString, Styled, Window, deferred, div, prelude::*,
};
use serde_json::{Map, Value};

use super::consent::ConsentView;
use super::dialog::dialog_frame;
use super::input_box::InputBoxView;
use super::model::{
    CommandView, ConsentOwner, PanelContent, PluginHost, PluginPopover, SidePanelCard, SurfaceKind,
};
use super::quick_pick::QuickPickView;
use super::side_panel::{
    BODY_PAD, HEADER_PAD_LEFT, HEADER_PAD_RIGHT, MISSING, MISSING_PAD, PanelMotions, plugins_of,
};
use super::surface::{PluginSurfaceView, SurfaceSpec, body, surface_entity};
use super::tokens::{dialog, overlay, side_panel, surface, symbol};
use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics};
use crate::look::Palette;
use crate::primitives::controls::{EmptyDrag, IconButton, glass_panel};
use crate::primitives::icons::Icon;
use crate::scale::px;
use crate::window::layout::Rect;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LayerFrame {
    pub card: Rect,
    pub gap: f32,
    pub radius: f32,
    pub viewport_width: f32,
    pub glass: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct PanelResize;

pub struct PluginLayer {
    host: Arc<dyn UiHost>,
    window_id: WindowId,
    frame: LayerFrame,
    p: Palette,
    popover: Option<(String, Entity<PluginSurfaceView>)>,
    command: Option<(String, Entity<PluginSurfaceView>)>,
    quick_pick: Option<(u64, Entity<QuickPickView>)>,
    input_box: Option<(u64, Entity<InputBoxView>)>,
    consent: Option<(String, Entity<ConsentView>)>,
    panels: HashMap<String, Entity<PluginSurfaceView>>,
    files: super::file_view::FileViews,
    _link: HostLink,
}

pub fn popover_key(popover: &PluginPopover) -> String {
    format!("{}:{}:{}", popover.plugin, popover.item, popover.view)
}

pub fn popover_right(room: f32, popover: &PluginPopover) -> f32 {
    dialog::POPOVER_MARGIN.max(room - (popover.anchor.x + popover.anchor.width))
}

impl PluginLayer {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let link = HostLink::new(
            host.host_signal(),
            HostTopics::PLUGINS,
            window,
            cx,
            |_, _, _, cx| cx.notify(),
        );
        PluginLayer {
            host,
            window_id,
            frame: LayerFrame::default(),
            p,
            popover: None,
            command: None,
            quick_pick: None,
            input_box: None,
            consent: None,
            panels: HashMap::new(),
            files: super::file_view::FileViews::default(),
            _link: link,
        }
    }

    pub fn set_frame(&mut self, frame: LayerFrame, p: Palette, cx: &mut Context<Self>) {
        if self.frame != frame || self.p != p {
            self.frame = frame;
            self.p = p;
            cx.notify();
        }
    }

    fn surface(
        &self,
        plugin: &str,
        view: &str,
        kind: SurfaceKind,
        context: Map<String, Value>,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<Entity<PluginSurfaceView>> {
        surface_entity(
            &self.host,
            SurfaceSpec {
                plugin: plugin.to_owned(),
                view: view.to_owned(),
                kind,
                window: self.window_id.clone(),
                context,
            },
            self.p,
            window,
            cx,
        )
    }

    fn sync(&mut self, plugins: &Arc<dyn PluginHost>, window: &mut Window, cx: &mut Context<Self>) {
        let popover = plugins.popover(&self.window_id);
        let wanted = popover.as_ref().map(popover_key);
        if self.popover.as_ref().map(|(k, _)| k) != wanted.as_ref() {
            self.popover = popover.and_then(|popover| {
                let mut context = Map::new();
                context.insert("itemId".into(), Value::String(popover.item.clone()));
                self.surface(
                    &popover.plugin,
                    &popover.view,
                    SurfaceKind::Popover,
                    context,
                    window,
                    cx,
                )
                .map(|entity| (popover_key(&popover), entity))
            });
        }
        let command = plugins.command_view(&self.window_id);
        let wanted = command.as_ref().map(|c| format!("{}:{}", c.plugin, c.view));
        if self.command.as_ref().map(|(k, _)| k) != wanted.as_ref() {
            self.command = command.and_then(|view| {
                let mut context = Map::new();
                context.insert("command".into(), Value::String(view.command.clone()));
                let entity = self.surface(
                    &view.plugin,
                    &view.view,
                    SurfaceKind::Command,
                    context,
                    window,
                    cx,
                )?;
                let focus = entity.read(cx).focus_handle().clone();
                window.focus(&focus, cx);
                Some((format!("{}:{}", view.plugin, view.view), entity))
            });
        }
        let pick = plugins
            .quick_pick()
            .filter(|request| request.window == self.window_id);
        if self.quick_pick.as_ref().map(|(id, _)| *id) != pick.as_ref().map(|r| r.id) {
            let p = self.p;
            self.quick_pick = pick.map(|request| {
                let id = request.id;
                let plugins = Arc::clone(plugins);
                (
                    id,
                    cx.new(|cx| QuickPickView::new(plugins, request, p, window, cx)),
                )
            });
        }
        let input = plugins
            .input_box()
            .filter(|request| request.window == self.window_id);
        if self.input_box.as_ref().map(|(id, _)| *id) != input.as_ref().map(|r| r.id) {
            let p = self.p;
            self.input_box = input.map(|request| {
                let id = request.id;
                let plugins = Arc::clone(plugins);
                (
                    id,
                    cx.new(|cx| InputBoxView::new(plugins, request, p, window, cx)),
                )
            });
        }
        let consent = plugins
            .consent()
            .filter(|request| request.owner == ConsentOwner::Window);
        let wanted = consent.as_ref().map(|c| format!("{}:{}", c.id, c.hash));
        if self.consent.as_ref().map(|(k, _)| k) != wanted.as_ref() {
            let p = self.p;
            self.consent = consent.map(|request| {
                let key = format!("{}:{}", request.id, request.hash);
                let plugins = Arc::clone(plugins);
                (
                    key,
                    cx.new(|cx| ConsentView::new(plugins, request, p, window, cx)),
                )
            });
        }
    }

    fn command_sheet(
        &self,
        view: &CommandView,
        surface: &Entity<PluginSurfaceView>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let plugins = self.host.plugins();
        let window_id = self.window_id.clone();
        let close = move || {
            if let Some(plugins) = &plugins {
                plugins.close_command_view(&window_id);
            }
        };
        let close_key = close.clone();
        let close_button = close.clone();
        let content = div()
            .id("plugin-command-keys")
            .on_key_down(move |event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.stop_propagation();
                    close_key();
                }
            })
            .flex()
            .flex_col()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(space::M))
                    .px(px(space::L))
                    .py(px(space::M))
                    .child(
                        div()
                            .size(px(overlay::COMMAND_ICON + dialog::POPOVER_MARGIN / 2.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(symbol(
                                if view.icon.is_empty() {
                                    "puzzlepiece"
                                } else {
                                    &view.icon
                                },
                                overlay::COMMAND_ICON,
                                p.icon,
                            )),
                    )
                    .child(
                        body(view.title.clone(), p.text)
                            .font_weight(FontWeight::SEMIBOLD)
                            .flex_1()
                            .truncate(),
                    )
                    .child(
                        IconButton::new("plugin-command-close", Icon::XMark, &p)
                            .square(20., 10.)
                            .glyph(9.)
                            .tooltip("Close", &p)
                            .on_click(move |_, _, _| close_button()),
                    ),
            )
            .child(div().h(px(0.5)).bg(p.divider))
            .child(
                div()
                    .id("plugin-command-body")
                    .max_h(px(overlay::COMMAND_HEIGHT))
                    .overflow_y_scroll()
                    .p(px(dialog::POPOVER_MARGIN))
                    .child(surface.clone()),
            );
        let _ = cx;
        dialog_frame(
            "plugin-command-sheet",
            dialog::WIDTH_L,
            0.0,
            Some(overlay::COMMAND_HEIGHT),
            &p,
            content.into_any_element(),
            move |_, _, _| close(),
        )
    }

    fn toolbar_popover(
        &self,
        popover: &PluginPopover,
        surface: &Entity<PluginSurfaceView>,
    ) -> AnyElement {
        let p = self.p;
        let right = popover_right(self.frame.viewport_width, popover);
        let plugins = self.host.plugins();
        let window_id = self.window_id.clone();
        deferred(
            div()
                .absolute()
                .inset_0()
                .child(div().absolute().inset_0().on_mouse_down(
                    MouseButton::Left,
                    move |_, _, _| {
                        if let Some(plugins) = &plugins {
                            plugins.close_popover(&window_id);
                        }
                    },
                ))
                .child(
                    div()
                        .absolute()
                        .top(px(popover.anchor.y
                            + popover.anchor.height
                            + overlay::POPOVER_GAP))
                        .right(px(right))
                        .w(px(overlay::POPOVER_WIDTH))
                        .child(crate::primitives::appear::rise(
                            gpui::ElementId::Name(
                                format!(
                                    "plugin-toolbar-popover-in:{}:{}:{}",
                                    popover.plugin, popover.item, popover.view
                                )
                                .into(),
                            ),
                            glass_panel(
                                "plugin-toolbar-popover",
                                false,
                                ardia_theme::layout::panel::RADIUS,
                                &p,
                            )
                            .debug_selector(|| "plugin-toolbar-popover".into())
                            .w(px(overlay::POPOVER_WIDTH))
                            .max_h(px(overlay::POPOVER_MAX_HEIGHT))
                            .overflow_hidden()
                            .text_color(p.text)
                            .child(surface.clone()),
                            crate::primitives::appear::Rise::popover(
                                crate::primitives::appear::OriginX::Right,
                                false,
                            ),
                        )),
                ),
        )
        .with_priority(2)
        .into_any_element()
    }

    fn panel_card(
        &mut self,
        plugins: &Arc<dyn PluginHost>,
        card: &SidePanelCard,
        current: bool,
        live: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let key = card.key();
        let body_element = match &card.content {
            PanelContent::Missing => div()
                .p(px(MISSING_PAD))
                .child(body(MISSING, p.text_secondary))
                .into_any_element(),
            PanelContent::File(url) => {
                let host = Arc::clone(&self.host);
                let window_id = self.window_id.clone();
                self.files.element(
                    &host,
                    super::file_view::FileSpec {
                        window: &window_id,
                        plugin: &card.plugin,
                        url,
                        key: &format!("panel:{key}"),
                        context: None,
                    },
                    window,
                    cx,
                )
            }
            PanelContent::Surface { view } => {
                if !self.panels.contains_key(&key) {
                    let mut context = Map::new();
                    context.insert("panelId".into(), Value::String(card.panel.clone()));
                    if let Some(entity) =
                        self.surface(&card.plugin, view, SurfaceKind::Panel, context, window, cx)
                    {
                        self.panels.insert(key.clone(), entity);
                    }
                }
                div()
                    .size_full()
                    .p(px(BODY_PAD))
                    .children(self.panels.get(&key).cloned())
                    .into_any_element()
            }
        };
        let close = {
            let plugins = Arc::clone(plugins);
            let window_id = self.window_id.clone();
            let plugin = card.plugin.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, _: &mut App| {
                plugins.close_side_panel(&window_id, &plugin)
            }
        };
        div()
            .id(SharedString::from(format!("plugin-side-panel:{key}")))
            .absolute()
            .inset_0()
            .rounded(px(self.frame.radius))
            .overflow_hidden()
            .bg(p.card)
            .opacity(if current { 1.0 } else { 0.0 })
            .when(live, |this| this.occlude())
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(side_panel::HEADER))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(space::M))
                    .pl(px(HEADER_PAD_LEFT))
                    .pr(px(HEADER_PAD_RIGHT))
                    .child(
                        div()
                            .size(px(surface::ICON_BOX))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(symbol(&card.icon, surface::ICON, p.icon)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(TypeSize::Body.points()))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.text)
                            .child(card.title.clone()),
                    )
                    .child(
                        IconButton::new(
                            SharedString::from(format!("plugin-side-panel-close:{key}")),
                            Icon::XMark,
                            &p,
                        )
                        .glyph(13.)
                        .tooltip("Close Side Panel", &p)
                        .on_click(close),
                    ),
            )
            .child(div().h(px(0.5)).flex_none().bg(p.divider))
            .child(div().flex_1().min_h_0().child(body_element))
            .into_any_element()
    }

    fn side_panel(
        &mut self,
        plugins: &Arc<dyn PluginHost>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let state = plugins.side_panel(&self.window_id);
        let now = Instant::now();
        let motion = {
            let motions = cx.default_global::<PanelMotions>();
            let motion = motions.0.entry(self.window_id.clone()).or_default();
            motion.update(&state, now);
            motion.clone()
        };
        let cards = motion.cards(&state);
        let keys: Vec<String> = cards.iter().map(SidePanelCard::key).collect();
        self.panels.retain(|key, _| keys.contains(key));
        if cards.is_empty() {
            return None;
        }
        if motion.running(now) {
            window.request_animation_frame();
        }
        let appear = motion.appear(now);
        let current = motion.current_key(&state);
        let live = state.shown.as_ref().map(SidePanelCard::key);
        let card_elements: Vec<AnyElement> = cards
            .iter()
            .map(|card| {
                let key = card.key();
                self.panel_card(
                    plugins,
                    card,
                    Some(&key) == current.as_ref(),
                    Some(&key) == live.as_ref(),
                    window,
                    cx,
                )
            })
            .collect();
        let frame = self.frame;
        let width = motion.width;
        let right_edge = frame.card.x + frame.card.w + frame.gap + width;
        let window_id = self.window_id.clone();
        let reset_id = self.window_id.clone();
        Some(
            div()
                .debug_selector(|| "plugin-side-panel".into())
                .absolute()
                .left(px(frame.card.x + frame.card.w + frame.gap))
                .top(px(frame.card.y))
                .w(px(width))
                .h(px(frame.card.h))
                .opacity(appear)
                .children(card_elements)
                .child(
                    div()
                        .id("plugin-side-panel-resize")
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(px(side_panel::HANDLE_OFFSET))
                        .w(px(side_panel::HANDLE))
                        .cursor(gpui::CursorStyle::ResizeLeftRight)
                        .on_click(move |event, window, cx| {
                            if event.click_count() == 2 {
                                if let Some(motion) =
                                    cx.default_global::<PanelMotions>().0.get_mut(&reset_id)
                                {
                                    motion.reset_width();
                                }
                                window.refresh();
                            }
                        })
                        .on_drag(PanelResize, |_, _, _, cx| cx.new(|_| EmptyDrag))
                        .on_drag_move(
                            move |event: &gpui::DragMoveEvent<PanelResize>, window, cx| {
                                let x = crate::scale::points(event.event.position.x);
                                if let Some(motion) =
                                    cx.default_global::<PanelMotions>().0.get_mut(&window_id)
                                {
                                    motion.resize(right_edge - x);
                                }
                                window.refresh();
                            },
                        ),
                )
                .into_any_element(),
        )
    }
}

impl Render for PluginLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(plugins) = plugins_of(&self.host, &self.window_id) else {
            self.popover = None;
            self.command = None;
            self.quick_pick = None;
            self.input_box = None;
            self.consent = None;
            self.panels.clear();
            return div().into_any_element();
        };
        self.sync(&plugins, window, cx);
        self.files.begin();
        let side = self.side_panel(&plugins, window, cx);
        let host = Arc::clone(&self.host);
        self.files.finish(&host, window, cx);
        let popover = plugins
            .popover(&self.window_id)
            .zip(self.popover.as_ref().map(|(_, e)| e.clone()))
            .map(|(popover, surface)| self.toolbar_popover(&popover, &surface));
        let command = plugins
            .command_view(&self.window_id)
            .zip(self.command.as_ref().map(|(_, e)| e.clone()))
            .map(|(view, surface)| self.command_sheet(&view, &surface, cx));
        div()
            .debug_selector(|| "plugin-layer".into())
            .absolute()
            .inset_0()
            .children(side)
            .children(popover)
            .children(command)
            .children(self.quick_pick.as_ref().map(|(_, v)| v.clone()))
            .children(self.input_box.as_ref().map(|(_, v)| v.clone()))
            .children(self.consent.as_ref().map(|(_, v)| v.clone()))
            .into_any_element()
    }
}

thread_local! {
    static MOUNTED: std::cell::RefCell<Mounted> = std::cell::RefCell::new(Mounted::default());
}

#[derive(Default)]
struct Mounted {
    sidebars: HashMap<WindowId, gpui::AnyView>,
    pages: HashMap<ardia_state::TabId, gpui::AnyView>,
}

pub fn plugin_page_name(url: &str) -> Option<String> {
    let rest = url
        .get(..8)
        .filter(|s| s.eq_ignore_ascii_case("ardia://"))
        .map(|_| &url[8..])?;
    let name = rest.split(['/', '?', '#']).next()?.to_ascii_lowercase();
    (!name.is_empty()
        && !["newtab", "history", "bookmarks", "downloads", "settings"].contains(&name.as_str()))
    .then_some(name)
}

pub fn mounted_sidebar(window: &WindowId) -> Option<AnyElement> {
    MOUNTED.with(|m| {
        m.borrow()
            .sidebars
            .get(window)
            .cloned()
            .map(IntoElement::into_any_element)
    })
}

pub fn mounted_page(tab: &ardia_state::TabId) -> Option<AnyElement> {
    MOUNTED.with(|m| {
        m.borrow()
            .pages
            .get(tab)
            .cloned()
            .map(IntoElement::into_any_element)
    })
}

fn mount_extras(
    host: &Arc<dyn UiHost>,
    window_id: &WindowId,
    p: Palette,
    window: &mut Window,
    cx: &mut App,
) {
    let Some(plugins) = host.plugins() else {
        MOUNTED.with(|m| {
            let mut m = m.borrow_mut();
            m.sidebars.remove(window_id);
        });
        return;
    };
    let eligible = plugins.window_eligible(window_id);
    let sidebar = eligible.then(|| {
        let key = SharedString::from(format!("plugin-sidebar-views:{window_id}"));
        let (host, id) = (Arc::clone(host), window_id.clone());
        let entity = window.use_keyed_state(key, cx, move |window, cx| {
            super::sidebar_views::PluginSidebarViews::new(host, id, p, window, cx)
        });
        entity.update(cx, |views, cx| views.set_palette(p, cx));
        gpui::AnyView::from(entity)
    });
    let state = host.store().snapshot();
    let tabs: Vec<(ardia_state::TabId, String)> = state
        .window(window_id.as_str())
        .map(|w| {
            w.tab_ids
                .iter()
                .filter_map(|id| state.tab(id.as_str()))
                .filter_map(|t| {
                    plugin_page_name(&t.url)
                        .filter(|n| plugins.has_plugin(n))
                        .map(|n| (t.id.clone(), n))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut pages = Vec::new();
    for (tab, name) in tabs {
        let key = SharedString::from(format!("plugin-page:{tab}:{name}"));
        let (host, id, tab_id) = (Arc::clone(host), window_id.clone(), tab.clone());
        let entity = window.use_keyed_state(key, cx, move |window, cx| {
            super::page::PluginPageView::new(host, id, tab_id, name, p, window, cx)
        });
        pages.push((tab, gpui::AnyView::from(entity)));
    }
    MOUNTED.with(|m| {
        let mut m = m.borrow_mut();
        match sidebar {
            Some(view) => m.sidebars.insert(window_id.clone(), view),
            None => m.sidebars.remove(window_id),
        };
        let window_tabs: Vec<ardia_state::TabId> = state
            .window(window_id.as_str())
            .map(|w| w.tab_ids.to_vec())
            .unwrap_or_default();
        m.pages.retain(|tab, _| !window_tabs.contains(tab));
        m.pages.extend(pages);
    });
}

pub fn plugin_layer(
    host: &Arc<dyn UiHost>,
    window_id: &WindowId,
    frame: LayerFrame,
    p: Palette,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    mount_extras(host, window_id, p, window, cx);
    host.plugins()?;
    let key = SharedString::from(format!("plugin-layer:{window_id}"));
    let host = Arc::clone(host);
    let id = window_id.clone();
    let layer = window.use_keyed_state(key, cx, move |window, cx| {
        PluginLayer::new(host, id, p, window, cx)
    });
    layer.update(cx, |layer, cx| layer.set_frame(frame, p, cx));
    Some(layer.into_any_element())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::model::Anchor;

    #[test]
    fn plugin_pages_are_ardia_urls_that_arent_built_in() {
        assert_eq!(
            plugin_page_name("ardia://notes?ardiaPanel=x"),
            Some("notes".into())
        );
        assert_eq!(plugin_page_name("ARDIA://Notes/"), Some("notes".into()));
        assert_eq!(plugin_page_name("ardia://history"), None);
        assert_eq!(plugin_page_name("https://notes"), None);
    }

    #[test]
    fn popovers_hang_under_their_button_and_stay_on_screen() {
        let popover = PluginPopover {
            plugin: "p".into(),
            item: "i".into(),
            view: "v".into(),
            anchor: Anchor {
                x: 900.0,
                y: 10.0,
                width: 28.0,
                height: 28.0,
            },
        };
        assert_eq!(popover_key(&popover), "p:i:v");
        assert_eq!(popover_right(1000.0, &popover), 72.0);
        assert_eq!(popover_right(920.0, &popover), 8.0);
    }
}
