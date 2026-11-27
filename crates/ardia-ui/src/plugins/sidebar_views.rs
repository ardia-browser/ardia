use std::collections::HashMap;
use std::sync::Arc;

use ardia_state::WindowId;
use ardia_theme::tokens::space;
use gpui::{
    Context, Entity, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled, Window,
    div, prelude::*,
};
use serde_json::Map;

use super::model::{SidebarViewEntry, SurfaceKind};
use super::side_panel::plugins_of;
use super::surface::{PluginSurfaceView, SurfaceSpec, body, chevron, list_row, surface_entity};
use super::tokens::{ROW_HEIGHT, surface, symbol};
use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics};
use crate::look::Palette;
use crate::scale::px;

pub struct PluginSidebarViews {
    host: Arc<dyn UiHost>,
    window_id: WindowId,
    closed: HashMap<String, bool>,
    surfaces: HashMap<String, Entity<PluginSurfaceView>>,
    synced: Vec<(String, bool)>,
    p: Palette,
    _link: HostLink,
}

impl PluginSidebarViews {
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
            |view, _, window, cx| {
                view.sync_surfaces(window, cx);
                cx.notify();
            },
        );
        let mut view = PluginSidebarViews {
            host,
            window_id,
            closed: HashMap::new(),
            surfaces: HashMap::new(),
            synced: Vec::new(),
            p,
            _link: link,
        };
        view.sync_surfaces(window, cx);
        view
    }

    fn view_keys(&self) -> Option<Vec<(String, SidebarViewEntry)>> {
        let plugins = plugins_of(&self.host, &self.window_id)?;
        Some(
            plugins
                .sidebar_views()
                .into_iter()
                .map(|v| (format!("{}:{}", v.plugin, v.id), v))
                .collect(),
        )
    }

    fn shown_keys(&self, views: &[(String, SidebarViewEntry)]) -> Vec<(String, bool)> {
        views
            .iter()
            .map(|(key, _)| (key.clone(), !self.closed.get(key).copied().unwrap_or(false)))
            .collect()
    }

    fn sync_surfaces(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let views = self.view_keys().unwrap_or_default();
        self.synced = self.shown_keys(&views);
        self.surfaces
            .retain(|key, _| views.iter().any(|(known, _)| known == key));
        for (key, view) in views {
            let open = !self.closed.get(&key).copied().unwrap_or(false);
            if !open {
                self.surfaces.remove(&key);
            } else if !self.surfaces.contains_key(&key)
                && let Some(entity) = surface_entity(
                    &self.host,
                    SurfaceSpec {
                        plugin: view.plugin.clone(),
                        view: view.id,
                        kind: SurfaceKind::Sidebar,
                        window: self.window_id.clone(),
                        context: Map::new(),
                    },
                    self.p,
                    window,
                    cx,
                )
            {
                self.surfaces.insert(key, entity);
            }
        }
    }

    pub fn set_palette(&mut self, p: Palette, cx: &mut Context<Self>) {
        if self.p != p {
            self.p = p;
            cx.notify();
        }
    }
}

impl Render for PluginSidebarViews {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = self.p;
        let views = self.view_keys().unwrap_or_default();
        if self.shown_keys(&views) != self.synced {
            cx.defer_in(window, |view, window, cx| {
                view.sync_surfaces(window, cx);
                cx.notify();
            });
        }
        if views.is_empty() {
            return div().into_any_element();
        }
        let mut sections = Vec::new();
        for (key, view) in &views {
            let open = !self.closed.get(key).copied().unwrap_or(false);
            let toggle = key.clone();
            sections.push(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        list_row(
                            SharedString::from(format!("plugin-sidebar-view:{key}")),
                            false,
                            ROW_HEIGHT,
                            &p,
                        )
                        .on_click(cx.listener(move |view, _, window, cx| {
                            let closed = view.closed.entry(toggle.clone()).or_default();
                            *closed = !*closed;
                            view.sync_surfaces(window, cx);
                            cx.notify();
                        }))
                        .child(chevron(open, &p))
                        .child(
                            div()
                                .size(px(surface::ICON_BOX))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(symbol(
                                    if view.icon.is_empty() {
                                        "puzzlepiece"
                                    } else {
                                        &view.icon
                                    },
                                    surface::ICON,
                                    p.icon,
                                )),
                        )
                        .child(
                            body(view.title.clone(), p.text_secondary)
                                .font_weight(FontWeight::MEDIUM)
                                .flex_1()
                                .truncate(),
                        ),
                    )
                    .when_some(
                        open.then(|| self.surfaces.get(key).cloned()).flatten(),
                        |this, surface| this.child(surface),
                    )
                    .into_any_element(),
            );
        }
        div()
            .debug_selector(|| "plugin-sidebar-views".into())
            .flex()
            .flex_col()
            .gap(px(space::XS))
            .children(sections)
            .into_any_element()
    }
}
