use std::sync::Arc;

use ardia_state::{TabId, WindowId};
use ardia_theme::tokens::{TypeSize, space};
use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled, Window,
    div, prelude::*,
};
use serde_json::{Map, Value};

use super::model::{PluginPageState, SurfaceKind};
use super::side_panel::plugins_of;
use super::surface::{PluginSurfaceView, SurfaceSpec, body, surface_entity};
use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics};
use crate::look::Palette;
use crate::primitives::controls::PushButton;
use crate::scale::px;

pub fn notice_copy(state: &PluginPageState) -> Option<(String, String)> {
    Some(match state {
        PluginPageState::PrivateWindow => (
            "Plugins aren't available in private windows".into(),
            "Open this plugin in a regular window.".into(),
        ),
        PluginPageState::Off { title } => (
            format!("{title} is off"),
            "Turn the plugin on in Settings › Plugins to use its page.".into(),
        ),
        PluginPageState::Starting { title } => (
            format!("{title} is starting…"),
            "Its program is getting the page ready.".into(),
        ),
        PluginPageState::Stopped { title } => (
            format!("{title} stopped"),
            "Its program isn't running. Restart it from Settings › Plugins.".into(),
        ),
        PluginPageState::Surface { .. } | PluginPageState::File { .. } => return None,
    })
}

pub struct PluginPageView {
    host: Arc<dyn UiHost>,
    window_id: WindowId,
    tab: TabId,
    name: String,
    surface: Option<(String, Entity<PluginSurfaceView>)>,
    p: Palette,
    files: super::file_view::FileViews,
    _link: HostLink,
}

impl PluginPageView {
    pub fn new(
        host: Arc<dyn UiHost>,
        window_id: WindowId,
        tab: TabId,
        name: String,
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
        PluginPageView {
            host,
            window_id,
            tab,
            name,
            surface: None,
            p,
            files: super::file_view::FileViews::default(),
            _link: link,
        }
    }

    fn notice(&self, title: String, detail: String, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        div()
            .debug_selector(|| "plugin-page-notice".into())
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(space::M))
            .p(px(space::XL))
            .child(
                div()
                    .text_size(px(TypeSize::Large.points()))
                    .line_height(px(TypeSize::Large.line_height()))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .child(title),
            )
            .child(body(detail, p.text_secondary))
            .child(
                PushButton::new("plugin-page-settings", "Open Plugin Settings", &p).on_click(
                    cx.listener(|view, _, _, _| {
                        if let Some(plugins) = view.host.plugins() {
                            plugins.open_plugin_settings(&view.name);
                        }
                    }),
                ),
            )
            .into_any_element()
    }
}

impl Drop for PluginPageView {
    fn drop(&mut self) {
        let host = Arc::clone(&self.host);
        self.files.release_all(&host);
    }
}

impl Render for PluginPageView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let state = match self.host.plugins() {
            None => PluginPageState::Off {
                title: self.name.clone(),
            },
            Some(_) if plugins_of(&self.host, &self.window_id).is_none() => {
                PluginPageState::PrivateWindow
            }
            Some(plugins) => {
                plugins
                    .page(&self.tab, &self.name)
                    .unwrap_or_else(|| PluginPageState::Off {
                        title: self.name.clone(),
                    })
            }
        };
        if let Some((title, detail)) = notice_copy(&state) {
            self.surface = None;
            return self.notice(title, detail, cx);
        }
        match state {
            PluginPageState::Surface { view, panel } => {
                let key = format!("{view}@{}", self.tab);
                if self.surface.as_ref().is_none_or(|(known, _)| *known != key) {
                    let mut context = Map::new();
                    context.insert("tabId".into(), Value::String(self.tab.to_string()));
                    context.insert("panelId".into(), Value::String(panel));
                    self.surface = surface_entity(
                        &self.host,
                        SurfaceSpec {
                            plugin: self.name.clone(),
                            view,
                            kind: SurfaceKind::Panel,
                            window: self.window_id.clone(),
                            context,
                        },
                        self.p,
                        window,
                        cx,
                    )
                    .map(|entity| (key, entity));
                }
                div()
                    .size_full()
                    .p(px(space::M))
                    .children(self.surface.as_ref().map(|(_, s)| s.clone()))
                    .into_any_element()
            }
            PluginPageState::File { url, context } => {
                self.surface = None;
                let host = Arc::clone(&self.host);
                let (window_id, name, key) = (
                    self.window_id.clone(),
                    self.name.clone(),
                    format!("page:{}", self.tab),
                );
                self.files.begin();
                let element = self.files.element(
                    &host,
                    super::file_view::FileSpec {
                        window: &window_id,
                        plugin: &name,
                        url: &url,
                        key: &key,
                        context,
                    },
                    window,
                    cx,
                );
                self.files.finish(&host, window, cx);
                element
            }
            _ => div().into_any_element(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_match_the_old_page_copy() {
        assert_eq!(
            notice_copy(&PluginPageState::Off {
                title: "Notes".into()
            })
            .unwrap()
            .0,
            "Notes is off"
        );
        assert_eq!(
            notice_copy(&PluginPageState::Stopped {
                title: "Notes".into()
            })
            .unwrap()
            .1,
            "Its program isn't running. Restart it from Settings › Plugins."
        );
        assert!(
            notice_copy(&PluginPageState::File {
                url: "x".into(),
                context: None
            })
            .is_none()
        );
    }
}
