use std::sync::Arc;

use futures::future::LocalBoxFuture;

pub type Answer<T> = LocalBoxFuture<'static, Result<T, String>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanguageStatus {
    Installed,
    Supported,
    Unsupported,
}

impl LanguageStatus {
    pub fn parse(text: &str) -> LanguageStatus {
        match text {
            "installed" => LanguageStatus::Installed,
            "supported" => LanguageStatus::Supported,
            _ => LanguageStatus::Unsupported,
        }
    }
}

pub type Blocks = Vec<Option<Vec<String>>>;

pub trait Translator: Send + Sync {
    fn available(&self) -> bool;
    fn user_languages(&self) -> Vec<String>;
    fn language_name(&self, language: &str) -> String;
    fn detect(&self, text: &str) -> Option<String>;
    fn status(&self, source: &str, target: &str) -> Answer<LanguageStatus>;
    fn supported_languages(&self) -> Answer<Vec<String>>;
    fn prepare(&self, source: &str, target: &str) -> Answer<()>;
    fn translate_blocks(
        &self,
        source: &str,
        target: &str,
        blocks: Vec<Vec<String>>,
        owner: &str,
    ) -> Answer<Blocks>;
    fn open(&self, owner: &str) -> Answer<()>;
    fn cancel(&self, owner: &str);
}

pub struct NoTranslator;

impl Translator for NoTranslator {
    fn available(&self) -> bool {
        false
    }

    fn user_languages(&self) -> Vec<String> {
        Vec::new()
    }

    fn language_name(&self, language: &str) -> String {
        language.to_owned()
    }

    fn detect(&self, _text: &str) -> Option<String> {
        None
    }

    fn status(&self, _source: &str, _target: &str) -> Answer<LanguageStatus> {
        Box::pin(async { Ok(LanguageStatus::Unsupported) })
    }

    fn supported_languages(&self) -> Answer<Vec<String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn prepare(&self, _source: &str, _target: &str) -> Answer<()> {
        Box::pin(async { Err("needs macOS 26".to_owned()) })
    }

    fn translate_blocks(
        &self,
        _source: &str,
        _target: &str,
        blocks: Vec<Vec<String>>,
        _owner: &str,
    ) -> Answer<Blocks> {
        Box::pin(async move { Ok(blocks.iter().map(|_| None).collect()) })
    }

    fn open(&self, _owner: &str) -> Answer<()> {
        Box::pin(async { Ok(()) })
    }

    fn cancel(&self, _owner: &str) {}
}

pub fn system_translator() -> Arc<dyn Translator> {
    #[cfg(translate_shim)]
    {
        Arc::new(swift::SwiftTranslator)
    }
    #[cfg(not(translate_shim))]
    {
        Arc::new(NoTranslator)
    }
}

#[cfg(translate_shim)]
mod swift {
    use std::ffi::{CStr, CString, c_char, c_void};

    use futures::channel::oneshot;
    use serde_json::{Value, json};

    use super::{Answer, Blocks, LanguageStatus, Translator};

    type Reply = extern "C" fn(*mut c_void, *const c_char);

    unsafe extern "C" {
        fn ardia_translate_free(text: *mut c_char);
        fn ardia_translate_available() -> bool;
        fn ardia_translate_user_languages() -> *mut c_char;
        fn ardia_translate_language_name(identifier: *const c_char) -> *mut c_char;
        fn ardia_translate_detect(text: *const c_char) -> *mut c_char;
        fn ardia_translate_call(
            op: *const c_char,
            args: *const c_char,
            context: *mut c_void,
            reply: Reply,
        );
    }

    fn take(text: *mut c_char) -> Option<String> {
        if text.is_null() {
            return None;
        }
        let owned = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned();
        unsafe { ardia_translate_free(text) };
        Some(owned)
    }

    fn c_text(text: &str) -> CString {
        CString::new(text.replace('\0', " ")).unwrap_or_default()
    }

    extern "C" fn answered(context: *mut c_void, text: *const c_char) {
        if context.is_null() {
            return;
        }
        let sender = unsafe { Box::from_raw(context.cast::<oneshot::Sender<String>>()) };
        let answer = if text.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned()
        };
        let _ = sender.send(answer);
    }

    fn call(
        op: &str,
        args: Value,
    ) -> futures::future::LocalBoxFuture<'static, Result<Value, String>> {
        let (sender, receiver) = oneshot::channel::<String>();
        let context = Box::into_raw(Box::new(sender)).cast::<c_void>();
        let (op, args) = (c_text(op), c_text(&args.to_string()));
        unsafe { ardia_translate_call(op.as_ptr(), args.as_ptr(), context, answered) };
        Box::pin(async move {
            let text = receiver
                .await
                .map_err(|_| "the translation model went away".to_owned())?;
            let value: Value =
                serde_json::from_str(&text).map_err(|problem| problem.to_string())?;
            let value = value.get("v").cloned().unwrap_or(Value::Null);
            match value.get("error").and_then(Value::as_str) {
                Some(error) => Err(error.to_owned()),
                None => Ok(value),
            }
        })
    }

    pub struct SwiftTranslator;

    impl Translator for SwiftTranslator {
        fn available(&self) -> bool {
            unsafe { ardia_translate_available() }
        }

        fn user_languages(&self) -> Vec<String> {
            take(unsafe { ardia_translate_user_languages() })
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|value| value.get("v").cloned())
                .and_then(|value| serde_json::from_value(value).ok())
                .unwrap_or_default()
        }

        fn language_name(&self, language: &str) -> String {
            let id = c_text(language);
            take(unsafe { ardia_translate_language_name(id.as_ptr()) })
                .unwrap_or_else(|| language.to_owned())
        }

        fn detect(&self, text: &str) -> Option<String> {
            let text = c_text(text);
            take(unsafe { ardia_translate_detect(text.as_ptr()) })
        }

        fn status(&self, source: &str, target: &str) -> Answer<LanguageStatus> {
            let reply = call("status", json!({ "source": source, "target": target }));
            Box::pin(async move {
                let value = reply.await?;
                Ok(LanguageStatus::parse(value.as_str().unwrap_or_default()))
            })
        }

        fn supported_languages(&self) -> Answer<Vec<String>> {
            let reply = call("supportedLanguages", json!({}));
            Box::pin(async move { Ok(serde_json::from_value(reply.await?).unwrap_or_default()) })
        }

        fn prepare(&self, source: &str, target: &str) -> Answer<()> {
            let reply = call("prepare", json!({ "source": source, "target": target }));
            Box::pin(async move { reply.await.map(|_| ()) })
        }

        fn translate_blocks(
            &self,
            source: &str,
            target: &str,
            blocks: Vec<Vec<String>>,
            owner: &str,
        ) -> Answer<Blocks> {
            let count = blocks.len();
            let reply = call(
                "translateBlocks",
                json!({ "source": source, "target": target, "owner": owner, "blocks": blocks }),
            );
            Box::pin(async move {
                let value = reply.await?;
                let mut answers: Blocks = serde_json::from_value(value).unwrap_or_default();
                answers.resize(count, None);
                Ok(answers)
            })
        }

        fn open(&self, owner: &str) -> Answer<()> {
            let reply = call("open", json!({ "owner": owner }));
            Box::pin(async move { reply.await.map(|_| ()) })
        }

        fn cancel(&self, owner: &str) {
            drop(call("cancel", json!({ "owner": owner })));
        }
    }
}
