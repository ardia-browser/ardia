use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, EngineResult};
use crate::events::PromptKey;
use crate::types::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TabCommand {
    LoadUrl {
        url: String,
        user_initiated: bool,
    },
    GoBack,
    GoForward,
    Reload,
    ReloadIgnoringCache,
    Stop,
    GoToOffset {
        offset: i32,
    },
    LoadIfNeeded,
    Focus,
    Close,
    CloseNow,
    Find {
        text: String,
        forward: bool,
    },
    StopFinding,
    SetMuted {
        muted: bool,
    },
    SetZoom {
        factor: f64,
    },
    ZoomStep {
        direction: i32,
    },
    SetFrozen {
        frozen: bool,
    },
    ResolveUnresponsive {
        terminate: bool,
    },
    ShowDevTools,
    ShowDevToolsPanel {
        panel: String,
    },
    CloseDevTools,
    ExecuteJavaScript {
        code: String,
        frame: Option<String>,
    },
    CallPage {
        kind: String,
        json: String,
    },
    CallFrame {
        frame: String,
        kind: String,
        json: String,
    },
    GrantUserActivation {
        frame: String,
    },
    DeliverHeldPageMessages,
    ExitPictureInPicture,
    ExitFullscreen,
    ExitExclusiveAccess,
    OpenBlockedPopup {
        popup_id: String,
        always: bool,
    },
    ResolvePasswordPrompt {
        action: PasswordPromptAction,
        username: Option<String>,
    },
    ResolveAutofillPrompt {
        prompt_id: i64,
        action: AutofillPromptAction,
    },
    SetPageBackgroundColor {
        color: Option<Rgba>,
    },
    SetPageColor {
        color: Option<String>,
    },
    SetContentsBackgroundColor {
        color: Option<Rgba>,
    },
    NoteShown {
        shown: bool,
    },
    NoteInShownSlot,
    SetTemporary {
        temporary: bool,
    },
    SetTemporarySource {
        source: Option<EngineTabId>,
    },
}

impl TabCommand {
    pub fn validate(&self) -> EngineResult<()> {
        match self {
            Self::LoadUrl { url, .. } if url.trim().is_empty() => {
                Err(EngineError::bad_argument("an empty URL can't load"))
            }
            Self::SetZoom { factor } if !(factor.is_finite() && *factor > 0.0) => {
                Err(EngineError::bad_argument("zoom must be a positive number"))
            }
            Self::ZoomStep { direction } if !matches!(direction, -1..=1) => {
                Err(EngineError::bad_argument("zoom steps are -1, 0 or 1"))
            }
            Self::CallPage { kind, .. } | Self::CallFrame { kind, .. } if kind.is_empty() => {
                Err(EngineError::bad_argument("a page call needs a kind"))
            }
            Self::CallFrame { frame, .. } | Self::GrantUserActivation { frame }
                if frame.is_empty() =>
            {
                Err(EngineError::bad_argument("a frame call needs a frame"))
            }
            _ => Ok(()),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::LoadUrl { .. } => "loadUrl",
            Self::GoBack => "goBack",
            Self::GoForward => "goForward",
            Self::Reload => "reload",
            Self::ReloadIgnoringCache => "reloadIgnoringCache",
            Self::Stop => "stop",
            Self::GoToOffset { .. } => "goToOffset",
            Self::LoadIfNeeded => "loadIfNeeded",
            Self::Focus => "focus",
            Self::Close => "close",
            Self::CloseNow => "closeNow",
            Self::Find { .. } => "find",
            Self::StopFinding => "stopFinding",
            Self::SetMuted { .. } => "setMuted",
            Self::SetZoom { .. } => "setZoom",
            Self::ZoomStep { .. } => "zoomStep",
            Self::SetFrozen { .. } => "setFrozen",
            Self::ResolveUnresponsive { .. } => "resolveUnresponsive",
            Self::ShowDevTools => "showDevTools",
            Self::ShowDevToolsPanel { .. } => "showDevToolsPanel",
            Self::CloseDevTools => "closeDevTools",
            Self::ExecuteJavaScript { .. } => "executeJavaScript",
            Self::CallPage { .. } => "callPage",
            Self::CallFrame { .. } => "callFrame",
            Self::GrantUserActivation { .. } => "grantUserActivation",
            Self::DeliverHeldPageMessages => "deliverHeldPageMessages",
            Self::ExitPictureInPicture => "exitPictureInPicture",
            Self::ExitFullscreen => "exitFullscreen",
            Self::ExitExclusiveAccess => "exitExclusiveAccess",
            Self::OpenBlockedPopup { .. } => "openBlockedPopup",
            Self::ResolvePasswordPrompt { .. } => "resolvePasswordPrompt",
            Self::ResolveAutofillPrompt { .. } => "resolveAutofillPrompt",
            Self::SetPageBackgroundColor { .. } => "setPageBackgroundColor",
            Self::SetPageColor { .. } => "setPageColor",
            Self::SetContentsBackgroundColor { .. } => "setContentsBackgroundColor",
            Self::NoteShown { .. } => "noteShown",
            Self::NoteInShownSlot => "noteInShownSlot",
            Self::SetTemporary { .. } => "setTemporary",
            Self::SetTemporarySource { .. } => "setTemporarySource",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TabAction {
    Discard,
    UnloadKeepingHistory,
    ShowCastDialog,
    ShowAutofillSuggestions { passwords: bool },
    StopCapture,
    HasLiveFrame { frame: String },
    ExecuteChromeCommand { command: i32 },
    ShareThisTabInsteadFor { capturer: EngineTabId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WindowCommand {
    ActivateTab {
        tab: EngineTabId,
    },
    PlaceTab {
        tab: EngineTabId,
        index: i32,
        pinned: bool,
    },
    SetActiveProfile {
        profile: Option<EngineProfileId>,
    },
    PrepareProfile {
        profile: EngineProfileId,
    },
    ShowInactive,
    SetActedFullScreen {
        on: bool,
    },
    SetInternal {
        on: bool,
    },
    SetAutomation {
        on: bool,
    },
    Close,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ProfileCommand {
    Release,
    SetFlag { flag: ProfileFlag, on: bool },
    UnloadComponentExtension { extension_id: String },
    WarmSpareRenderer,
    HoldNavigationsUntilRulesetsOf { extension_id: String },
    ReleaseNavigationHold { reason: String },
    ReleaseNavigationHoldReady,
    WatchCastRoutes,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GlobalCommand {
    ResolvePermission {
        request_id: String,
        result: PermissionResult,
        remember: bool,
    },
    ResolveExtensionInstall {
        request_id: String,
        accepted: bool,
    },
    ResolveExternalApp {
        request_id: String,
        open: bool,
        remember: bool,
    },
    SelectDevice {
        chooser_id: i32,
        index: i32,
    },
    DeviceChooserAction {
        chooser_id: i32,
        action: DevicePickerAction,
    },
    StartCasting {
        dialog_id: i32,
        sink_id: String,
        mode: i32,
    },
    StopCasting {
        dialog_id: i32,
        route_id: String,
    },
    CloseCastDialog {
        dialog_id: i32,
    },
    TerminateCastRoute {
        route_id: String,
    },
    AllowDesktopCapture {
        source_id: String,
        tab: EngineTabId,
        frame: Option<String>,
        origin: Option<String>,
        audio: Option<String>,
    },
    SetPagesPickDisplayMedia {
        enabled: bool,
    },
    SetAutoPictureInPicture {
        enabled: bool,
    },
    SetVideoUpscaling {
        enabled: bool,
    },
    SetVideoUpscalingTestConditions {
        conditions: BTreeMap<String, f64>,
    },
    ReservedShortcutsChanged,
    ResolveCloseWithDownloads {
        request: u64,
        close_anyway: bool,
    },
}

impl GlobalCommand {
    pub fn validate(&self) -> EngineResult<()> {
        match self {
            Self::ResolvePermission { request_id, .. }
            | Self::ResolveExtensionInstall { request_id, .. }
            | Self::ResolveExternalApp { request_id, .. }
                if request_id.is_empty() =>
            {
                Err(EngineError::bad_argument(
                    "a resolution needs its request id",
                ))
            }
            Self::StartCasting { sink_id, .. } if sink_id.is_empty() => {
                Err(EngineError::bad_argument("casting needs a sink"))
            }
            Self::AllowDesktopCapture { source_id, .. } if source_id.is_empty() => {
                Err(EngineError::bad_argument("desktop capture needs a source"))
            }
            Self::SetVideoUpscalingTestConditions { conditions }
                if conditions.values().any(|v| !v.is_finite()) =>
            {
                Err(EngineError::bad_argument(
                    "test conditions must be finite numbers",
                ))
            }
            _ => Ok(()),
        }
    }

    pub fn settles(&self) -> Option<PromptKey> {
        Some(match self {
            Self::ResolvePermission { request_id, .. } => PromptKey::Permission(request_id.clone()),
            Self::ResolveExtensionInstall { request_id, .. } => {
                PromptKey::ExtensionInstall(request_id.clone())
            }
            Self::ResolveExternalApp { request_id, .. } => {
                PromptKey::ExternalApp(request_id.clone())
            }
            Self::ResolveCloseWithDownloads { request, .. } => {
                PromptKey::CloseWithDownloads(*request)
            }
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineQuery {
    ChromiumVersion,
    KeepAliveState,
    PictureInPictureCloses,
    VideoUpscalingState,
    DesktopCaptureAudio,
    PagesPickDisplayMedia,
    IsTracing,
    TestExternalLaunches,
    TestChooserEvents,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab(raw: u64) -> EngineTabId {
        EngineTabId::from_raw(raw).unwrap()
    }

    #[test]
    fn commands_frame_as_tagged_json() {
        let load = TabCommand::LoadUrl {
            url: "https://ardia.dev".into(),
            user_initiated: true,
        };
        assert_eq!(
            serde_json::to_value(&load).unwrap(),
            json!({"op": "loadUrl", "url": "https://ardia.dev", "userInitiated": true})
        );
        assert_eq!(
            serde_json::to_value(TabCommand::GoBack).unwrap(),
            json!({"op": "goBack"})
        );
        let place = WindowCommand::PlaceTab {
            tab: tab(4),
            index: 2,
            pinned: true,
        };
        assert_eq!(
            serde_json::to_value(&place).unwrap(),
            json!({"op": "placeTab", "tab": 4, "index": 2, "pinned": true})
        );
        let permission = GlobalCommand::ResolvePermission {
            request_id: "r1".into(),
            result: PermissionResult::Accept,
            remember: false,
        };
        assert_eq!(
            serde_json::to_value(&permission).unwrap(),
            json!({"op": "resolvePermission", "requestId": "r1", "result": "accept", "remember": false})
        );
        let flag = ProfileCommand::SetFlag {
            flag: ProfileFlag::PreloadPages,
            on: true,
        };
        assert_eq!(
            serde_json::to_value(&flag).unwrap(),
            json!({"op": "setFlag", "flag": "preloadPages", "on": true})
        );
        let action = TabAction::ShareThisTabInsteadFor { capturer: tab(9) };
        assert_eq!(
            serde_json::to_value(&action).unwrap(),
            json!({"op": "shareThisTabInsteadFor", "capturer": 9})
        );
    }

    #[test]
    fn command_names_match_their_tags() {
        let commands = [
            TabCommand::GoForward,
            TabCommand::ZoomStep { direction: 1 },
            TabCommand::ResolvePasswordPrompt {
                action: PasswordPromptAction::Never,
                username: None,
            },
            TabCommand::SetTemporarySource { source: None },
            TabCommand::NoteInShownSlot,
        ];
        for command in commands {
            assert_eq!(
                serde_json::to_value(&command).unwrap()["op"],
                json!(command.name())
            );
        }
    }

    #[test]
    fn validation_rejects_nonsense() {
        assert!(
            TabCommand::LoadUrl {
                url: " ".into(),
                user_initiated: false
            }
            .validate()
            .is_err()
        );
        assert!(TabCommand::SetZoom { factor: f64::NAN }.validate().is_err());
        assert!(TabCommand::SetZoom { factor: 0.0 }.validate().is_err());
        assert!(TabCommand::ZoomStep { direction: 4 }.validate().is_err());
        assert!(
            TabCommand::CallFrame {
                frame: String::new(),
                kind: "x".into(),
                json: "{}".into()
            }
            .validate()
            .is_err()
        );
        assert!(TabCommand::SetZoom { factor: 1.25 }.validate().is_ok());
        assert!(
            GlobalCommand::ResolveExternalApp {
                request_id: String::new(),
                open: true,
                remember: true
            }
            .validate()
            .is_err()
        );
        assert!(
            GlobalCommand::StartCasting {
                dialog_id: 1,
                sink_id: String::new(),
                mode: 1
            }
            .validate()
            .is_err()
        );
        assert!(
            GlobalCommand::SetVideoUpscalingTestConditions {
                conditions: [("gpu".to_string(), f64::INFINITY)].into()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn answers_name_the_prompt_they_settle() {
        assert_eq!(
            GlobalCommand::ResolveCloseWithDownloads {
                request: 4,
                close_anyway: true
            }
            .settles(),
            Some(PromptKey::CloseWithDownloads(4))
        );
        assert_eq!(
            GlobalCommand::SelectDevice {
                chooser_id: 2,
                index: 0
            }
            .settles(),
            None,
            "a chooser stays open until the engine says it closed"
        );
        assert_eq!(
            GlobalCommand::DeviceChooserAction {
                chooser_id: 2,
                action: DevicePickerAction::Cancel
            }
            .settles(),
            None
        );
        assert_eq!(
            GlobalCommand::ResolvePermission {
                request_id: "r".into(),
                result: PermissionResult::Deny,
                remember: false
            }
            .settles(),
            Some(PromptKey::Permission("r".into()))
        );
        assert_eq!(GlobalCommand::ReservedShortcutsChanged.settles(), None);
    }
}
