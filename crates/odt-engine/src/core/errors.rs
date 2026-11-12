//! `core/errors.ts`: the typed failures of opening an ODT.
//!
//! The TypeScript throws `OdtOpenError` (and its two subclasses) and, from
//! anywhere else, a plain `Error`. Both are `OdtError` here: `Open` carries the
//! `OdtOpenErrorCode` and the message, `Thrown` the message of any other
//! thrown `Error`. The wire answers `{ error: { code, message } }` from
//! `code_and_message`.

use std::fmt;

/// `OdtOpenErrorCode`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OdtOpenErrorCode {
    /// the manifest marks parts encrypted: a password-protected ODT
    Encrypted,
    /// the package is not an OpenDocument text document
    NotOdtText,
    /// the zip failed the size / inflation gate shared with the docx engine
    ZipRejected,
    /// not a readable zip, or a required part is missing
    Corrupt,
}

impl OdtOpenErrorCode {
    /// The string the TypeScript holds.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Encrypted => "encrypted",
            Self::NotOdtText => "not-odt-text",
            Self::ZipRejected => "zip-rejected",
            Self::Corrupt => "corrupt",
        }
    }
}

/// `OdtOpenError` (and `OdtEncryptedError`, `OdtNotTextError`), or any other
/// thrown `Error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OdtError {
    /// `OdtOpenError`: the code and the English message.
    Open {
        code: OdtOpenErrorCode,
        message: String,
    },
    /// Any other thrown `Error`: its message.
    Thrown(String),
}

pub type OdtResult<T> = Result<T, OdtError>;

impl OdtError {
    /// `new OdtOpenError(code, message)`
    pub fn open(code: OdtOpenErrorCode, message: impl Into<String>) -> Self {
        Self::Open {
            code,
            message: message.into(),
        }
    }

    /// `new Error(message)`
    pub fn thrown(message: impl Into<String>) -> Self {
        Self::Thrown(message.into())
    }

    /// `new OdtEncryptedError()`
    pub fn encrypted() -> Self {
        Self::open(
            OdtOpenErrorCode::Encrypted,
            "odt: the document is password-protected (encrypted parts)",
        )
    }

    /// `new OdtNotTextError(mediaType)`: `None` is `null`.
    pub fn not_text(media_type: Option<&str>) -> Self {
        let shown = match media_type {
            None => "missing".to_owned(),
            Some(text) => jscompat::json_to_string(text).unwrap_or_default(),
        };
        Self::open(
            OdtOpenErrorCode::NotOdtText,
            format!("odt: not an OpenDocument text document (media type {shown})"),
        )
    }

    /// The `code` of an `OdtOpenError`, or `None` for any other error.
    pub fn open_code(&self) -> Option<OdtOpenErrorCode> {
        match self {
            Self::Open { code, .. } => Some(*code),
            Self::Thrown(_) => None,
        }
    }

    /// The message of the error.
    pub fn message(&self) -> &str {
        match self {
            Self::Open { message, .. } | Self::Thrown(message) => message,
        }
    }

    /// What the wire answers: an open error its code string, any other thrown
    /// error `"thrown"` and its message.
    pub fn code_and_message(&self) -> (&'static str, String) {
        match self {
            Self::Open { code, message } => (code.as_str(), message.clone()),
            Self::Thrown(message) => ("thrown", message.clone()),
        }
    }
}

impl fmt::Display for OdtError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for OdtError {}

/// `isOdtOpenError(err, code?)`
pub fn is_odt_open_error(err: &OdtError, code: Option<OdtOpenErrorCode>) -> bool {
    match (err, code) {
        (OdtError::Open { .. }, None) => true,
        (OdtError::Open { code: own, .. }, Some(code)) => *own == code,
        (OdtError::Thrown(_), _) => false,
    }
}
