use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportError {
    NotFound,
    Unreadable,
    TooLarge,
}

impl ImportError {
    pub fn code(self) -> &'static str {
        match self {
            ImportError::NotFound => "notFound",
            ImportError::Unreadable => "unreadable",
            ImportError::TooLarge => "tooLarge",
        }
    }
}

impl fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ImportError {}
