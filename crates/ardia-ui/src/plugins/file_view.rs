use std::collections::HashSet;
use std::sync::Arc;

use ardia_state::{TabId, WindowId};
use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, Window, div};

use crate::host::UiHost;
use crate::window::native_views::NativeViews;

#[derive(Default)]
pub struct FileViews {
    natives: NativeViews,
    used: HashSet<String>,
    held: HashSet<String>,
}

pub struct FileSpec<'a> {
    pub window: &'a WindowId,
    pub plugin: &'a str,
    pub url: &'a str,
    pub key: &'a str,
    pub context: Option<String>,
}

impl FileViews {
    pub fn begin(&mut self) {
        self.used.clear();
    }

    pub fn element(
        &mut self,
        host: &Arc<dyn UiHost>,
        spec: FileSpec,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let key = spec.key.to_owned();
        self.used.insert(key.clone());
        let handle = host.plugins().and_then(|plugins| {
            plugins.file_view(spec.window, spec.plugin, spec.url, spec.key, spec.context)
        });
        if handle.is_some() {
            self.held.insert(key.clone());
        }
        let view = self.natives.attach(
            &TabId::new(key),
            false,
            handle,
            gpui::transparent_black(),
            window,
            cx,
        );
        div().size_full().children(view).into_any_element()
    }

    pub fn finish(&mut self, host: &Arc<dyn UiHost>, window: &mut Window, cx: &mut App) {
        let gone: Vec<String> = self.held.difference(&self.used).cloned().collect();
        if gone.is_empty() {
            return;
        }
        let owner = window.window_handle().window_id();
        let used = self.used.clone();
        self.natives
            .retain(owner, |tab| used.contains(tab.as_str()), cx);
        for key in gone {
            self.held.remove(&key);
            if let Some(plugins) = host.plugins() {
                plugins.release_file_view(&key);
            }
        }
    }

    pub fn release_all(&mut self, host: &Arc<dyn UiHost>) {
        if let Some(plugins) = host.plugins() {
            for key in self.held.drain() {
                plugins.release_file_view(&key);
            }
        }
    }
}
