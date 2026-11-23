#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateError {
    TooLarge,
    Manifest,
    Signature,
    NotNewer,
    Kind,
    Version,
    Channel,
}

impl UpdateError {
    pub fn code(self) -> &'static str {
        match self {
            UpdateError::TooLarge => "tooLarge",
            UpdateError::Manifest => "manifest",
            UpdateError::Signature => "signature",
            UpdateError::NotNewer => "notNewer",
            UpdateError::Kind => "kind",
            UpdateError::Version => "version",
            UpdateError::Channel => "channel",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        [
            UpdateError::TooLarge,
            UpdateError::Manifest,
            UpdateError::Signature,
            UpdateError::NotNewer,
            UpdateError::Kind,
            UpdateError::Version,
            UpdateError::Channel,
        ]
        .into_iter()
        .find(|error| error.code() == code)
    }
}

impl core::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for UpdateError {}
