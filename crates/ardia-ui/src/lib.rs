pub mod bookmarks_bar;
pub mod content;
pub mod host;
pub mod host_data;
pub mod icon_picker;
pub mod import;
pub mod keybindings;
pub mod little_ardia;
pub mod live;
pub mod look;
pub mod media;
pub mod mock;
pub mod msg;
pub mod ntp;
pub mod omnibox;
pub mod onboarding;
pub mod pages;
pub mod plugins;
pub mod popovers;
pub mod press_telemetry;
pub mod primitives;
pub mod profiled;
pub mod profiles;
pub mod report;
pub mod scale;
pub mod settings;
pub mod site;
pub mod sidebar;
pub mod store_link;
pub mod sync_api;
pub mod theme_editor;
pub mod window;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use anyhow::Context as _;
use ardia_state::windows::WindowKind;
use gpui::{AnyWindowHandle, App, AppContext, px, size};

pub use host::{
    AboutInfo, AppIconChoice, ArcThemeChoice, ThemePresetEvent, ClearBrowsingData, Confirmation, DownloadSettings, LoginItemState, PluginRow, ProfileFlagKind, ProfileFlags, HostTabView, NativeMenuItem, TextPrompt, OnboardingRecord, OnboardingSystem,
    OnboardingSystemChoice, OpenWindowTarget, PageCommand, UiHost, UtilityWindowKind,
    bind_global_keybindings,
};
pub use mock::{HostCall, MockUiHost};
pub use pages::InternalPage;
pub use pages::reader::ReaderStatus;
pub use window::browser_window::BrowserWindowView;

#[cfg(target_os = "macos")]
use gpui_macos as _;

pub fn ui_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn open_browser_window(
    host: Arc<dyn UiHost>,
    target: OpenWindowTarget,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let state = host.store().snapshot();
    let browser = state
        .window(target.window_id.as_str())
        .with_context(|| format!("there is no window {}", target.window_id))?;
    anyhow::ensure!(
        matches!(browser.kind, WindowKind::Main | WindowKind::Incognito),
        "window {} is not a browser window",
        target.window_id
    );
    let inset = state.page_frame_inset_in(target.window_id.as_str(), browser.is_full_screen());
    let lights = primitives::theme_bridge::traffic_light_origin(
        ardia_theme::layout::lights::center(inset, state.settings.compact_toolbar),
    );
    let bounds = window::frame_bounds(browser.frame.as_ref(), window::DEFAULT_SIZE, cx);
    let options = window::window_options(window::WindowSpec {
        bounds,
        title: "Ardia",
        lights,
        min: size(
            px(ardia_theme::layout::MIN_WINDOW_WIDTH),
            px(window::MIN_HEIGHT),
        ),
        background: target.background,
        host_window: target.host_window,
        resizable: true,
    });
    let id = target.window_id.clone();
    let view_host = Arc::clone(&host);
    let handle = cx.open_window(options, move |window, cx| {
        cx.new(|cx| BrowserWindowView::new(view_host, id, window, cx))
    })?;
    window::WindowRegistry::insert(target.window_id.clone(), handle, cx);
    host.register_gpui_window(target.window_id, handle.into());
    Ok(handle.into())
}

pub fn open_little_ardia_window(
    host: Arc<dyn UiHost>,
    target: OpenWindowTarget,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let state = host.store().snapshot();
    let little = state
        .window(target.window_id.as_str())
        .with_context(|| format!("there is no window {}", target.window_id))?;
    anyhow::ensure!(
        little.kind == WindowKind::LittleArdia,
        "window {} is not a Little Ardia window",
        target.window_id
    );
    let visible = cx
        .primary_display()
        .map(|display| {
            let bounds = display.bounds();
            [f32::from(bounds.size.width), f32::from(bounds.size.height)]
        })
        .unwrap_or([1512.0, 949.0]);
    let size_points = little_ardia::little_bounds(state.settings.little_ardia_size, visible);
    let bounds = window::frame_bounds(little.frame.as_ref(), size_points, cx);
    let options = window::window_options(window::WindowSpec {
        bounds,
        title: "Little Ardia",
        lights: primitives::theme_bridge::traffic_light_origin(
            ardia_theme::layout::lights::LITTLE_ARDIA_CENTER,
        ),
        min: size(
            px(ardia_theme::layout::LITTLE_ARDIA_MIN_SIZE[0]),
            px(ardia_theme::layout::LITTLE_ARDIA_MIN_SIZE[1]),
        ),
        background: target.background,
        host_window: target.host_window,
        resizable: true,
    });
    let id = target.window_id.clone();
    let view_host = Arc::clone(&host);
    let handle = cx.open_window(options, move |window, cx| {
        cx.new(|cx| little_ardia::LittleArdiaWindowView::new(view_host, id, window, cx))
    })?;
    host.register_gpui_window(target.window_id, handle.into());
    Ok(handle.into())
}

fn utility_options(
    title: &'static str,
    dimensions: [f32; 2],
    min: [f32; 2],
    cx: &App,
) -> gpui::WindowOptions {
    window::window_options(window::WindowSpec {
        bounds: window::frame_bounds(None, dimensions, cx),
        title,
        lights: primitives::theme_bridge::traffic_light_origin(
            ardia_theme::layout::lights::SETTINGS_CENTER,
        ),
        min: size(px(min[0]), px(min[1])),
        background: false,
        host_window: None,
        resizable: true,
    })
}

pub fn open_settings_window(
    host: Arc<dyn UiHost>,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let options = utility_options("Settings", settings::SETTINGS_SIZE, [640.0, 420.0], cx);
    let handle = cx.open_window(options, move |window, cx| {
        cx.new(|cx| settings::SettingsWindowView::new(host, window, cx))
    })?;
    Ok(handle.into())
}

pub fn open_import_window(host: Arc<dyn UiHost>, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    let options = utility_options("Import", import::IMPORT_SIZE, [520.0, 460.0], cx);
    let handle = cx.open_window(options, move |window, cx| {
        cx.new(|cx| import::ImportWindowView::new(host, window, cx))
    })?;
    Ok(handle.into())
}

pub fn open_intro_window(host: Arc<dyn UiHost>, cx: &mut App) -> anyhow::Result<AnyWindowHandle> {
    if cx.reduce_motion() {
        return open_onboarding_window(host, cx);
    }
    onboarding::intro_window::open(host, cx)
}

pub fn open_onboarding_window(
    host: Arc<dyn UiHost>,
    cx: &mut App,
) -> anyhow::Result<AnyWindowHandle> {
    let options = utility_options(
        "Welcome to Ardia",
        onboarding::ONBOARDING_SIZE,
        [640.0, 480.0],
        cx,
    );
    let handle = cx.open_window(options, move |window, cx| {
        cx.new(|cx| onboarding::OnboardingWindowView::new(host, window, cx))
    })?;
    Ok(handle.into())
}
