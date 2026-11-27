use crate::types::{EngineProfileId, EngineTabId, EngineWindowId};

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EngineError {
    #[error("the browser engine isn't loaded: {0}")]
    NotLoaded(String),
    #[error("the browser engine hasn't started yet")]
    NotStarted,
    #[error("the browser engine is already running")]
    AlreadyRunning,
    #[error("the browser engine must be driven from the main thread")]
    WrongThread,
    #[error("{0} is gone or was never opened")]
    UnknownWindow(EngineWindowId),
    #[error("{0} is gone or was never opened")]
    UnknownTab(EngineTabId),
    #[error("{0} is gone or was never loaded")]
    UnknownProfile(EngineProfileId),
    #[error("this engine can't {0}")]
    Unsupported(&'static str),
    #[error("bad argument: {0}")]
    BadArgument(String),
    #[error("the engine has no {0}")]
    MissingService(String),
    #[error("{service}: {message}")]
    Service { service: String, message: String },
    #[error("the engine sent a reply that couldn't be read: {0}")]
    BadReply(String),
    #[error("the request was cancelled before the engine answered")]
    Cancelled,
    #[error("{0}")]
    Failed(String),
}

pub type EngineResult<T> = Result<T, EngineError>;

impl EngineError {
    pub fn bad_argument(message: impl Into<String>) -> Self {
        Self::BadArgument(message.into())
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }

    pub fn is_gone(&self) -> bool {
        matches!(
            self,
            Self::UnknownWindow(_) | Self::UnknownTab(_) | Self::UnknownProfile(_)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_read_plainly() {
        let tab = EngineTabId::from_raw(3).unwrap();
        assert_eq!(
            EngineError::UnknownTab(tab).to_string(),
            "tab-3 is gone or was never opened"
        );
        assert_eq!(
            EngineError::Service {
                service: "ac_bookmarks_tree".into(),
                message: "profile went away".into()
            }
            .to_string(),
            "ac_bookmarks_tree: profile went away"
        );
        assert!(EngineError::UnknownTab(tab).is_gone());
        assert!(!EngineError::Cancelled.is_gone());
    }
}
