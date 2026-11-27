pub mod abi;
pub mod commands;
pub mod desktop;
pub mod error;
pub mod events;
pub mod launch;
pub mod loader;
pub mod mock;
pub mod policy;
pub mod reply;
pub mod services;
pub mod types;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use zeroize::Zeroizing;

pub use commands::{
    EngineQuery, GlobalCommand, ProfileCommand, TabAction, TabCommand, WindowCommand,
};
pub use error::{EngineError, EngineResult};
pub use events::{
    DEFAULT_EVENT_CAPACITY, EngineEvent, EventBus, EventSubscription, OPEN_PROMPT_LIMIT, PromptKey,
    UrlSender,
};
pub use launch::{LaunchOptions, is_background, merge_feature_lists};
pub use mock::MockBrowserEngine;
pub use policy::{DefaultPolicy, HostPolicy, NewBrowserWindow};
pub use reply::{Reply, Responder};
pub use services::{DownloadCommand, SecretValue, ServiceName, Services};
pub use types::*;

pub const PAGE_SCRIPT: &str = include_str!("page_script.js");

pub const fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub trait BrowserEngine {
    fn backend(&self) -> EngineBackend;
    fn events(&self) -> &EventBus;
    fn set_policy(&self, policy: Arc<dyn HostPolicy>);

    fn subscribe(&self) -> EventSubscription {
        self.events().subscribe()
    }

    fn open_prompts(&self) -> Vec<EngineEvent> {
        self.events().open_prompts()
    }

    fn run_with_args(&self, args: &[String]) -> EngineResult<i32>;
    fn is_started(&self) -> bool;
    fn quit(&self) -> EngineResult<()>;
    fn query(&self, query: EngineQuery) -> EngineResult<Value>;
    fn set_page_script(&self, script: Option<&str>) -> EngineResult<()>;
    fn global(&self, command: GlobalCommand) -> EngineResult<()>;

    fn begin_tracing(&self) -> Reply<bool> {
        Reply::err(EngineError::Unsupported("trace the engine"))
    }

    fn end_tracing(&self, keep: bool) -> Reply<Option<String>> {
        let _ = keep;
        Reply::err(EngineError::Unsupported("trace the engine"))
    }

    fn default_profile(&self) -> EngineResult<EngineProfileId>;
    fn load_profile(&self, directory_name: &str) -> Reply<EngineProfileId>;
    fn off_the_record_profile(&self, profile: EngineProfileId) -> Reply<EngineProfileId>;
    fn delete_profile(&self, profile: EngineProfileId) -> Reply<bool>;
    fn profile_info(&self, profile: EngineProfileId) -> EngineResult<ProfileInfo>;
    fn profile_command(
        &self,
        profile: EngineProfileId,
        command: ProfileCommand,
    ) -> EngineResult<()>;
    fn load_component_extension(
        &self,
        profile: EngineProfileId,
        path: &str,
    ) -> EngineResult<Option<String>>;
    fn sleep_idle_profile(
        &self,
        profile: EngineProfileId,
        hosted_tabs: &[EngineTabId],
    ) -> EngineResult<Option<String>>;
    fn unload_idle_profile(&self, profile: EngineProfileId) -> EngineResult<String>;
    fn fetch_icon(
        &self,
        profile: EngineProfileId,
        url: &str,
        max_bytes: usize,
    ) -> Reply<Option<Vec<u8>>>;
    fn clear_browsing_data(
        &self,
        profile: EngineProfileId,
        kinds: &[BrowsingDataKind],
        since_ms: Option<f64>,
    ) -> Reply<()>;

    fn create_window(&self, frame: Rect) -> EngineResult<EngineWindowId>;
    fn window_info(&self, window: EngineWindowId) -> EngineResult<WindowInfo>;
    fn native_window_handle(&self, window: EngineWindowId) -> EngineResult<NativeWindow>;
    fn window_host_view(&self, window: EngineWindowId) -> EngineResult<NativeView>;
    fn window_command(&self, window: EngineWindowId, command: WindowCommand) -> EngineResult<()>;
    fn open_tab(&self, window: EngineWindowId, request: OpenTab) -> EngineResult<EngineTabId>;
    fn open_extension_view(
        &self,
        window: EngineWindowId,
        url: &str,
        profile: EngineProfileId,
        kind: ExtensionViewKind,
    ) -> EngineResult<Option<EngineTabId>>;
    fn restore_tab(
        &self,
        window: EngineWindowId,
        state: Option<&str>,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>>;
    fn duplicate_tab(
        &self,
        window: EngineWindowId,
        source: EngineTabId,
        profile: EngineProfileId,
        foreground: bool,
    ) -> EngineResult<Option<EngineTabId>>;
    fn adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption>;
    fn can_adopt_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<Adoption>;
    fn tabs_for_profile(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<Vec<EngineTabId>>;
    fn chrome_window_id(
        &self,
        window: EngineWindowId,
        profile: EngineProfileId,
    ) -> EngineResult<i32>;
    fn execute_chrome_command(
        &self,
        window: EngineWindowId,
        command: i32,
        profile: EngineProfileId,
    ) -> EngineResult<bool>;

    fn tab_info(&self, tab: EngineTabId) -> EngineResult<TabInfo>;
    fn native_view_handle(&self, tab: EngineTabId) -> EngineResult<NativeView>;
    fn devtools_view_handle(&self, tab: EngineTabId) -> EngineResult<Option<NativeView>>;
    fn navigation_entries(&self, tab: EngineTabId) -> EngineResult<Vec<NavigationEntry>>;
    fn security_info(&self, tab: EngineTabId) -> EngineResult<SecurityInfo>;
    fn password_prompt(&self, tab: EngineTabId) -> EngineResult<Option<PasswordPrompt>>;
    fn autofill_prompt(&self, tab: EngineTabId) -> EngineResult<Option<AutofillPrompt>>;
    fn tab_command(&self, tab: EngineTabId, command: TabCommand) -> EngineResult<()>;
    fn tab_action(&self, tab: EngineTabId, action: TabAction) -> EngineResult<bool>;
    fn sleep_if_hidden(&self, tab: EngineTabId, seconds: f64) -> EngineResult<Vec<i32>>;
    fn execute_extension_action(
        &self,
        tab: EngineTabId,
        extension_id: &str,
    ) -> EngineResult<String>;
    fn extension_action_states(
        &self,
        tab: EngineTabId,
        extension_ids: &[String],
    ) -> EngineResult<ExtensionActionStates>;
    fn side_panel_url(&self, tab: EngineTabId, extension_id: &str) -> EngineResult<Option<String>>;
    fn evaluate_js(&self, tab: EngineTabId, code: &str) -> Reply<Option<Value>>;
    fn ask_before_leaving(&self, tab: EngineTabId) -> Reply<bool>;
    fn choose_files_to_open(&self, window: Option<EngineWindowId>) -> Reply<Vec<PathBuf>> {
        let _ = window;
        Reply::err(EngineError::Unsupported("choose files on this platform"))
    }
    fn enter_pip(&self, tab: EngineTabId, click_time: f64) -> Reply<PipEntry>;
    fn cover_page(&self, tab: EngineTabId) -> Reply<bool> {
        let _ = tab;
        Reply::err(EngineError::Unsupported("cover pages on this platform"))
    }
    fn uncover_page(&self, tab: EngineTabId, fade: bool) -> EngineResult<()> {
        let _ = (tab, fade);
        Err(EngineError::Unsupported("cover pages on this platform"))
    }
    fn devtools_call(
        &self,
        tab: EngineTabId,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Reply<Value>;

    fn devtools_layout(&self, tab: EngineTabId, size: Size) -> EngineResult<DevToolsLayout> {
        let _ = (tab, size);
        Err(EngineError::Unsupported("lay out DevTools"))
    }

    fn call_service(&self, name: &str, profile_dir: &str, args_json: &str) -> Reply<Value>;

    fn call_service_secret(
        &self,
        name: &str,
        profile_dir: &str,
        args_json: Zeroizing<String>,
    ) -> Reply<SecretValue>;

    fn page_view(&self, view: &NativeView, query: PageViewQuery) -> EngineResult<bool>;
    fn set_scroll_observer(&self, enabled: bool) -> EngineResult<()>;

    fn services<'a>(&'a self, profile_dir: &'a str) -> Services<'a, Self>
    where
        Self: Sized,
    {
        Services::new(self, profile_dir)
    }

    fn chromium_version(&self) -> EngineResult<String> {
        Ok(self
            .query(EngineQuery::ChromiumVersion)?
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }

    fn set_auto_pip(&self, enabled: bool) -> EngineResult<()> {
        self.global(GlobalCommand::SetAutoPictureInPicture { enabled })
    }

    fn set_video_upscaling(&self, enabled: bool) -> EngineResult<()> {
        self.global(GlobalCommand::SetVideoUpscaling { enabled })
    }

    fn resolve_permission(
        &self,
        request_id: &str,
        result: PermissionResult,
        remember: bool,
    ) -> EngineResult<()> {
        self.global(GlobalCommand::ResolvePermission {
            request_id: request_id.to_owned(),
            result,
            remember,
        })
    }

    fn resolve_extension_install(&self, request_id: &str, accepted: bool) -> EngineResult<()> {
        self.global(GlobalCommand::ResolveExtensionInstall {
            request_id: request_id.to_owned(),
            accepted,
        })
    }

    fn resolve_external_app(
        &self,
        request_id: &str,
        open: bool,
        remember: bool,
    ) -> EngineResult<()> {
        self.global(GlobalCommand::ResolveExternalApp {
            request_id: request_id.to_owned(),
            open,
            remember,
        })
    }

    fn select_device(&self, chooser_id: i32, index: i32) -> EngineResult<()> {
        self.global(GlobalCommand::SelectDevice { chooser_id, index })
    }

    fn cancel_device_chooser(&self, chooser_id: i32) -> EngineResult<()> {
        self.global(GlobalCommand::DeviceChooserAction {
            chooser_id,
            action: DevicePickerAction::Cancel,
        })
    }

    fn start_casting(&self, dialog_id: i32, sink_id: &str, mode: i32) -> EngineResult<()> {
        self.global(GlobalCommand::StartCasting {
            dialog_id,
            sink_id: sink_id.to_owned(),
            mode,
        })
    }

    fn stop_casting(&self, dialog_id: i32, route_id: &str) -> EngineResult<()> {
        self.global(GlobalCommand::StopCasting {
            dialog_id,
            route_id: route_id.to_owned(),
        })
    }

    fn allow_desktop_capture(
        &self,
        source_id: &str,
        tab: EngineTabId,
        frame: Option<&str>,
        origin: Option<&str>,
        audio: Option<&str>,
    ) -> EngineResult<()> {
        self.global(GlobalCommand::AllowDesktopCapture {
            source_id: source_id.to_owned(),
            tab,
            frame: frame.map(str::to_owned),
            origin: origin.map(str::to_owned),
            audio: audio.map(str::to_owned),
        })
    }

    fn resolve_close_with_downloads(&self, request: u64, close_anyway: bool) -> EngineResult<()> {
        self.global(GlobalCommand::ResolveCloseWithDownloads {
            request,
            close_anyway,
        })
    }

    fn release_profile(&self, profile: EngineProfileId) -> EngineResult<()> {
        self.profile_command(profile, ProfileCommand::Release)
    }

    fn set_profile_flag(
        &self,
        profile: EngineProfileId,
        flag: ProfileFlag,
        on: bool,
    ) -> EngineResult<()> {
        self.profile_command(profile, ProfileCommand::SetFlag { flag, on })
    }

    fn unload_component_extension(
        &self,
        profile: EngineProfileId,
        extension_id: &str,
    ) -> EngineResult<()> {
        self.profile_command(
            profile,
            ProfileCommand::UnloadComponentExtension {
                extension_id: extension_id.to_owned(),
            },
        )
    }

    fn set_active_profile(
        &self,
        window: EngineWindowId,
        profile: Option<EngineProfileId>,
    ) -> EngineResult<()> {
        self.window_command(window, WindowCommand::SetActiveProfile { profile })
    }

    fn activate_tab(&self, window: EngineWindowId, tab: EngineTabId) -> EngineResult<()> {
        self.window_command(window, WindowCommand::ActivateTab { tab })
    }

    fn place_tab(
        &self,
        window: EngineWindowId,
        tab: EngineTabId,
        index: i32,
        pinned: bool,
    ) -> EngineResult<()> {
        self.window_command(window, WindowCommand::PlaceTab { tab, index, pinned })
    }

    fn show_inactive(&self, window: EngineWindowId) -> EngineResult<()> {
        self.window_command(window, WindowCommand::ShowInactive)
    }

    fn set_acted_fullscreen(&self, window: EngineWindowId, on: bool) -> EngineResult<()> {
        self.window_command(window, WindowCommand::SetActedFullScreen { on })
    }

    fn close_window(&self, window: EngineWindowId) -> EngineResult<()> {
        self.window_command(window, WindowCommand::Close)
    }

    fn load_url(&self, tab: EngineTabId, url: &str, user_initiated: bool) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::LoadUrl {
                url: url.to_owned(),
                user_initiated,
            },
        )
    }

    fn go_back(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::GoBack)
    }

    fn go_forward(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::GoForward)
    }

    fn reload(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::Reload)
    }

    fn reload_ignoring_cache(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::ReloadIgnoringCache)
    }

    fn stop(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::Stop)
    }

    fn go_to_offset(&self, tab: EngineTabId, offset: i32) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::GoToOffset { offset })
    }

    fn focus(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::Focus)
    }

    fn close(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::Close)
    }

    fn close_now(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::CloseNow)
    }

    fn find(&self, tab: EngineTabId, text: &str, forward: bool) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::Find {
                text: text.to_owned(),
                forward,
            },
        )
    }

    fn stop_finding(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::StopFinding)
    }

    fn set_muted(&self, tab: EngineTabId, muted: bool) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::SetMuted { muted })
    }

    fn set_zoom(&self, tab: EngineTabId, factor: f64) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::SetZoom { factor })
    }

    fn zoom_step(&self, tab: EngineTabId, direction: i32) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::ZoomStep { direction })
    }

    fn discard(&self, tab: EngineTabId) -> EngineResult<bool> {
        self.tab_action(tab, TabAction::Discard)
    }

    fn set_frozen(&self, tab: EngineTabId, frozen: bool) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::SetFrozen { frozen })
    }

    fn show_devtools(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::ShowDevTools)
    }

    fn show_devtools_panel(&self, tab: EngineTabId, panel: &str) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::ShowDevToolsPanel {
                panel: panel.to_owned(),
            },
        )
    }

    fn close_devtools(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::CloseDevTools)
    }

    fn execute_js(&self, tab: EngineTabId, code: &str, frame: Option<&str>) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::ExecuteJavaScript {
                code: code.to_owned(),
                frame: frame.map(str::to_owned),
            },
        )
    }

    fn call_page(&self, tab: EngineTabId, kind: &str, json: &str) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::CallPage {
                kind: kind.to_owned(),
                json: json.to_owned(),
            },
        )
    }

    fn call_frame(
        &self,
        tab: EngineTabId,
        frame: &str,
        kind: &str,
        json: &str,
    ) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::CallFrame {
                frame: frame.to_owned(),
                kind: kind.to_owned(),
                json: json.to_owned(),
            },
        )
    }

    fn exit_pip(&self, tab: EngineTabId) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::ExitPictureInPicture)
    }

    fn show_cast_dialog(&self, tab: EngineTabId) -> EngineResult<bool> {
        self.tab_action(tab, TabAction::ShowCastDialog)
    }

    fn share_tab_instead(&self, target: EngineTabId, capturer: EngineTabId) -> EngineResult<bool> {
        self.tab_action(target, TabAction::ShareThisTabInsteadFor { capturer })
    }

    fn resolve_password_prompt(
        &self,
        tab: EngineTabId,
        action: PasswordPromptAction,
        username: Option<&str>,
        password: Option<&str>,
    ) -> EngineResult<()> {
        if password.is_some() {
            return Err(EngineError::Unsupported(
                "save an edited password on this platform",
            ));
        }
        self.tab_command(
            tab,
            TabCommand::ResolvePasswordPrompt {
                action,
                username: username.map(str::to_owned),
            },
        )
    }

    fn resolve_autofill_prompt(
        &self,
        tab: EngineTabId,
        prompt_id: i64,
        action: AutofillPromptAction,
    ) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::ResolveAutofillPrompt { prompt_id, action })
    }

    fn open_blocked_popup(
        &self,
        tab: EngineTabId,
        popup_id: &str,
        always: bool,
    ) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::OpenBlockedPopup {
                popup_id: popup_id.to_owned(),
                always,
            },
        )
    }

    fn set_page_background_color(&self, tab: EngineTabId, color: Option<Rgba>) -> EngineResult<()> {
        self.tab_command(
            tab,
            TabCommand::SetPageBackgroundColor {
                color: color.map(Rgba::clamped),
            },
        )
    }

    fn note_shown(&self, tab: EngineTabId, shown: bool) -> EngineResult<()> {
        self.tab_command(tab, TabCommand::NoteShown { shown })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_script_is_the_page_channel_function() {
        assert!(PAGE_SCRIPT.starts_with("(function (post) {"));
        assert!(PAGE_SCRIPT.trim_end().ends_with("})"));
        assert!(PAGE_SCRIPT.contains("return receive;"));
        assert!(
            !PAGE_SCRIPT
                .lines()
                .any(|line| line.trim_start().starts_with("//"))
        );
        assert!(!PAGE_SCRIPT.contains("/*"));
    }

    #[test]
    fn engine_version_is_the_workspace_version() {
        assert_eq!(engine_version(), env!("CARGO_PKG_VERSION"));
        assert!(!engine_version().is_empty());
    }

    #[test]
    fn the_trait_is_object_safe() {
        let engine: std::rc::Rc<dyn BrowserEngine> = std::rc::Rc::new(MockBrowserEngine::new());
        assert_eq!(engine.backend(), EngineBackend::Mock);
        let services = Services::new(engine.as_ref(), "");
        assert_eq!(services.profile_dir(), "");
    }
}
