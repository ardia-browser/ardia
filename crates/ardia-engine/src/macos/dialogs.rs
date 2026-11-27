use std::ffi::c_char;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{call_json, ensure_bridge_host, ffi, submit_async};
use crate::error::{EngineError, EngineResult};
use crate::reply::{Completion, Reply};
use crate::types::{NativeView, NativeWindow, Rect};

fn sheet_parent(parent: Option<&NativeWindow>) -> EngineResult<*mut std::ffi::c_void> {
    match parent {
        None => Ok(std::ptr::null_mut()),
        Some(window) => window.live_object().ok_or_else(|| {
            EngineError::bad_argument("sheets need a window from the engine or retain_window")
        }),
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AlertStyle {
    #[default]
    Warning,
    Informational,
    Critical,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PromptField {
    pub value: String,
    pub placeholder: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub title: String,
    pub message: String,
    pub style: AlertStyle,
    pub buttons: Vec<String>,
    pub destructive: bool,
    pub no_default: bool,
    pub cancel: Option<usize>,
    pub suppression: Option<String>,
    pub field: Option<PromptField>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct AlertResponse {
    pub button: Option<usize>,
    pub suppressed: bool,
    pub text: Option<String>,
    pub shown: bool,
}

impl AlertResponse {
    pub fn chose(&self, index: usize) -> bool {
        self.button == Some(index)
    }

    pub fn entered_text(&self) -> Option<&str> {
        self.text
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }
}

impl Alert {
    pub fn confirm(title: &str, message: &str, confirm: &str, cancel: &str) -> Self {
        Self {
            title: title.to_owned(),
            message: message.to_owned(),
            buttons: vec![confirm.to_owned(), cancel.to_owned()],
            cancel: Some(1),
            ..Self::default()
        }
    }

    pub fn prompt(
        title: &str,
        message: &str,
        value: &str,
        placeholder: &str,
        confirm: &str,
    ) -> Self {
        Self {
            field: Some(PromptField {
                value: value.to_owned(),
                placeholder: placeholder.to_owned(),
            }),
            ..Self::confirm(title, message, confirm, "Cancel")
        }
    }

    pub fn choose(title: &str, message: &str, choices: &[&str], cancel: Option<usize>) -> Self {
        Self {
            title: title.to_owned(),
            message: message.to_owned(),
            buttons: choices.iter().map(|choice| (*choice).to_owned()).collect(),
            cancel,
            ..Self::default()
        }
    }

    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub fn style(mut self, style: AlertStyle) -> Self {
        self.style = style;
        self
    }

    pub fn suppression(mut self, title: &str) -> Self {
        self.suppression = Some(title.to_owned());
        self
    }

    pub fn validate(&self) -> EngineResult<()> {
        if self.buttons.is_empty() || self.buttons.iter().any(|title| title.trim().is_empty()) {
            return Err(EngineError::bad_argument(
                "an alert needs buttons with titles",
            ));
        }
        if self
            .cancel
            .is_some_and(|cancel| cancel >= self.buttons.len())
        {
            return Err(EngineError::bad_argument(
                "the cancel button is out of range",
            ));
        }
        Ok(())
    }

    pub fn show(&self, parent: Option<&NativeWindow>) -> Reply<AlertResponse> {
        let window = match self
            .validate()
            .and_then(|_| sheet_parent(parent))
            .and_then(|window| ensure_bridge_host().map(|_| window))
        {
            Ok(window) => window,
            Err(error) => return Reply::err(error),
        };
        submit_async(
            |json, request| unsafe { ffi::ardia_bridge_alert(json, window, request) },
            self,
            |completion: Completion| {
                serde_json::from_value(completion.into_json()?)
                    .map_err(|e| EngineError::BadReply(e.to_string()))
            },
            || EngineError::bad_argument("that window is gone"),
        )
    }

    pub fn describe(&self) -> EngineResult<Value> {
        self.validate()?;
        call_json(
            |json: *const c_char, out| unsafe { ffi::ardia_bridge_alert_describe(json, out) },
            self,
            false,
            || EngineError::NotStarted,
        )
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FilePanelKind {
    #[default]
    Open,
    Save,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePanel {
    pub kind: FilePanelKind,
    pub multiple: bool,
    pub files: bool,
    pub directories: bool,
    pub create_directories: bool,
    pub prompt: Option<String>,
    pub message: Option<String>,
    pub directory: Option<PathBuf>,
    pub name: Option<String>,
    pub extensions: Vec<String>,
}

impl Default for FilePanel {
    fn default() -> Self {
        Self {
            kind: FilePanelKind::Open,
            multiple: false,
            files: true,
            directories: false,
            create_directories: false,
            prompt: None,
            message: None,
            directory: None,
            name: None,
            extensions: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
struct PanelAnswer {
    paths: Vec<PathBuf>,
}

impl FilePanel {
    pub fn open_files() -> Self {
        Self {
            multiple: true,
            ..Self::default()
        }
    }

    pub fn open_folder(current: Option<PathBuf>, prompt: Option<&str>) -> Self {
        Self {
            files: false,
            directories: true,
            create_directories: true,
            directory: current,
            prompt: prompt.map(str::to_owned),
            ..Self::default()
        }
    }

    pub fn save(name: &str, extensions: &[&str]) -> Self {
        Self {
            kind: FilePanelKind::Save,
            name: Some(name.to_owned()),
            extensions: extensions
                .iter()
                .map(|ext| ext.trim_start_matches('.').to_owned())
                .collect(),
            ..Self::default()
        }
    }

    pub fn validate(&self) -> EngineResult<()> {
        if self.kind == FilePanelKind::Open && !self.files && !self.directories {
            return Err(EngineError::bad_argument(
                "an open panel must allow files or folders",
            ));
        }
        if self
            .extensions
            .iter()
            .any(|ext| ext.is_empty() || ext.contains(['/', '.']))
        {
            return Err(EngineError::bad_argument(
                "extensions are bare names like \"html\"",
            ));
        }
        Ok(())
    }

    pub fn show(&self, parent: Option<&NativeWindow>) -> Reply<Vec<PathBuf>> {
        let window = match self
            .validate()
            .and_then(|_| sheet_parent(parent))
            .and_then(|window| ensure_bridge_host().map(|_| window))
        {
            Ok(window) => window,
            Err(error) => return Reply::err(error),
        };
        submit_async(
            |json, request| unsafe { ffi::ardia_bridge_file_panel(json, window, request) },
            self,
            |completion: Completion| {
                serde_json::from_value::<PanelAnswer>(completion.into_json()?)
                    .map(|answer| answer.paths)
                    .map_err(|e| EngineError::BadReply(e.to_string()))
            },
            || EngineError::bad_argument("that window is gone"),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareItem {
    Url(String),
    Text(String),
}

#[derive(Serialize)]
struct ShareRequest<'a> {
    items: Vec<ShareEntry<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareEntry<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
}

pub fn share(items: &[ShareItem], anchor: &NativeView, rect: Rect) -> EngineResult<()> {
    if items.is_empty() {
        return Err(EngineError::bad_argument("there's nothing to share"));
    }
    let view = anchor.live_object().ok_or_else(|| {
        EngineError::bad_argument("sharing needs a view from the engine or retain_view")
    })?;
    if !rect.is_valid() {
        return Err(EngineError::bad_argument(
            "sharing needs a finite rectangle",
        ));
    }
    let request = ShareRequest {
        items: items
            .iter()
            .map(|item| match item {
                ShareItem::Url(url) => ShareEntry {
                    url: Some(url),
                    text: None,
                },
                ShareItem::Text(text) => ShareEntry {
                    url: None,
                    text: Some(text),
                },
            })
            .collect(),
    };
    call_json(
        |json: *const c_char, _| unsafe {
            ffi::ardia_bridge_share(json, view, rect.x, rect.y, rect.width, rect.height)
        },
        &request,
        false,
        || EngineError::bad_argument("that view is gone"),
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn alerts_frame_for_the_bridge() {
        let confirm = Alert::confirm(
            "Close 3 tabs?",
            "They'll move to History.",
            "Close Tabs",
            "Cancel",
        )
        .destructive();
        assert_eq!(
            serde_json::to_value(&confirm).unwrap(),
            json!({
                "title": "Close 3 tabs?", "message": "They'll move to History.", "style": "warning",
                "buttons": ["Close Tabs", "Cancel"], "destructive": true, "noDefault": false, "cancel": 1,
                "suppression": null, "field": null
            })
        );
        assert!(confirm.validate().is_ok());
        let prompt = Alert::prompt("Rename Tab", "", "Inbox", "Tab name", "Rename");
        assert_eq!(prompt.field.as_ref().unwrap().value, "Inbox");
        assert_eq!(prompt.buttons, ["Rename", "Cancel"]);
    }

    #[test]
    fn invalid_alerts_never_reach_appkit() {
        assert!(Alert::choose("Pick", "", &[], None).validate().is_err());
        assert!(
            Alert::choose("Pick", "", &["A", " "], None)
                .validate()
                .is_err()
        );
        assert!(
            Alert::choose("Pick", "", &["A", "B"], Some(2))
                .validate()
                .is_err()
        );
        let mut reply = Alert::choose("Pick", "", &[], None).show(None);
        assert!(matches!(
            reply.try_take(),
            Some(Err(EngineError::BadArgument(_)))
        ));
        let forged = NativeWindow::borrowed(crate::types::NativeWindowHandle(0x1234 as *mut _));
        let mut sheet = Alert::confirm("Sure?", "", "Yes", "No").show(Some(&forged));
        assert!(matches!(
            sheet.try_take(),
            Some(Err(EngineError::BadArgument(_)))
        ));
        let mut panel = FilePanel::open_files().show(Some(&forged));
        assert!(matches!(
            panel.try_take(),
            Some(Err(EngineError::BadArgument(_)))
        ));
    }

    #[test]
    fn responses_read_plainly() {
        let response: AlertResponse = serde_json::from_value(
            json!({"button": 0, "suppressed": true, "text": "  hi ", "shown": true}),
        )
        .unwrap();
        assert!(response.chose(0));
        assert!(response.suppressed);
        assert_eq!(response.entered_text(), Some("hi"));
        let background: AlertResponse =
            serde_json::from_value(json!({"button": null, "shown": false})).unwrap();
        assert!(!background.chose(0));
        assert_eq!(background.entered_text(), None);
    }

    #[test]
    fn file_panels_validate_their_options() {
        assert!(FilePanel::open_files().validate().is_ok());
        assert!(
            FilePanel::open_folder(None, Some("Choose"))
                .validate()
                .is_ok()
        );
        assert_eq!(
            FilePanel::save("page.html", &[".html"]).extensions,
            ["html"]
        );
        assert!(
            FilePanel {
                files: false,
                ..FilePanel::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            FilePanel {
                extensions: vec!["a/b".into()],
                ..FilePanel::default()
            }
            .validate()
            .is_err()
        );
        let json = serde_json::to_value(FilePanel::save("x.pdf", &["pdf"])).unwrap();
        assert_eq!(json["kind"], json!("save"));
        assert_eq!(json["name"], json!("x.pdf"));
    }

    #[test]
    fn sharing_needs_items_and_an_anchor() {
        let none = NativeView::borrowed(crate::types::NativeViewHandle::NULL);
        assert!(
            share(
                &[ShareItem::Url("https://ardia.dev".into())],
                &none,
                Rect::default()
            )
            .is_err()
        );
        let fake = NativeView::borrowed(crate::types::NativeViewHandle(16 as *mut _));
        assert!(share(&[], &fake, Rect::default()).is_err());
        assert!(
            share(
                &[ShareItem::Text("x".into())],
                &fake,
                Rect::new(f64::NAN, 0.0, 1.0, 1.0)
            )
            .is_err()
        );
    }
}
