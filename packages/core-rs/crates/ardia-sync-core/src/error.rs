#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Format,
    Authentication,
    Random,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Error::Format => "format",
            Error::Authentication => "authentication",
            Error::Random => "random",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhraseError {
    WordCount(usize),
    UnknownWord(usize),
    Checksum,
}

impl PhraseError {
    pub fn code(&self) -> &'static str {
        match self {
            PhraseError::WordCount(_) => "wordCount",
            PhraseError::UnknownWord(_) => "unknownWord",
            PhraseError::Checksum => "checksum",
        }
    }
}
