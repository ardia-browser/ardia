use std::sync::Arc;

use ardia_state::TabId;
use ardia_theme::layout::panel;
use ardia_theme::tokens::TypeSize;
use gpui::{
    AnyElement, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled, div, prelude::*,
};

use super::model::{PluginHost, SiteSwitchRow};
use super::tokens::symbol;
use crate::look::Palette;
use crate::scale::px;

pub const SETTING_HEIGHT: f32 = 42.0;
pub const SETTING_BADGE: f32 = 26.0;

fn badge_rest(dark: bool) -> Hsla {
    if dark {
        gpui::white().opacity(0.11)
    } else {
        gpui::black().opacity(0.0825)
    }
}

pub fn switch_value(row: &SiteSwitchRow) -> &'static str {
    if row.on { "On" } else { "Off" }
}

pub fn site_switch_rows(
    plugins: &Arc<dyn PluginHost>,
    tab: &TabId,
    url: &str,
    p: &Palette,
) -> Vec<AnyElement> {
    plugins
        .site_switch_rows(tab)
        .into_iter()
        .map(|row| switch_row(plugins, row, url, p))
        .collect()
}

fn switch_row(
    plugins: &Arc<dyn PluginHost>,
    row: SiteSwitchRow,
    url: &str,
    p: &Palette,
) -> AnyElement {
    let p = *p;
    let id = SharedString::from(format!("site-switch:{}/{}", row.plugin, row.key));
    let selector = id.to_string();
    let plugins = Arc::clone(plugins);
    let url = url.to_owned();
    let (plugin, key, next) = (row.plugin.clone(), row.key.clone(), !row.on);
    div()
        .id(id)
        .debug_selector(move || selector)
        .mx(px(panel::ROW_INSET))
        .px(px(panel::ROW_PADDING))
        .h(px(SETTING_HEIGHT))
        .rounded(px(panel::ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(panel::ICON_GAP))
        .cursor_pointer()
        .hover(move |style| style.bg(p.menu_hover))
        .active(move |style| style.bg(p.popover_row_pressed))
        .on_click(move |_, _, _| {
            ardia_telemetry::counts::count(if next {
                "plugin_site_switch_on"
            } else {
                "plugin_site_switch_off"
            });
            plugins.set_site_switch(&plugin, &key, &url, next)
        })
        .child(
            div()
                .flex_none()
                .size(px(SETTING_BADGE))
                .rounded_full()
                .bg(if row.on { p.accent } else { badge_rest(p.dark) })
                .flex()
                .items_center()
                .justify_center()
                .child(symbol(
                    &row.icon,
                    12.,
                    if row.on { p.on_accent } else { p.icon },
                )),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(
                    div()
                        .text_size(px(TypeSize::Body.points()))
                        .line_height(px(TypeSize::Body.line_height()))
                        .font_weight(FontWeight::MEDIUM)
                        .truncate()
                        .child(row.title.clone()),
                )
                .child(
                    div()
                        .text_size(px(TypeSize::Caption.points()))
                        .line_height(px(TypeSize::Caption.line_height()))
                        .text_color(p.text_secondary)
                        .truncate()
                        .child(switch_value(&row)),
                ),
        )
        .into_any_element()
}
