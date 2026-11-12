//! `apps/epub/src/main/result-paths.ts`.
//!
//! Where a result book may be written (spec 8 "Result files"): never over the
//! book itself, never over a file a tab of the app has open, and only as an
//! `.epub` file. Pure; the caller supplies "is this path open in a tab".

use jscompat::js_regex;
use jscompat::node_path::host::{is_absolute, resolve};
use serde_json::{Map, Value};

/// `ResultPathContext`
pub struct ResultPathContext<'a> {
    /// the book's own file
    pub source_path: &'a str,
    /// whether a tab of the app (this editor's or any other) has the file open
    pub is_open_in_tab: &'a mut dyn FnMut(&str) -> bool,
    /// compare paths ignoring case; `None` is the platform's
    pub case_insensitive: Option<bool>,
}

/// `EpubResultPathRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultPathRefusal {
    Invalid,
    NotEpub,
    Source,
    OpenInTab,
}

impl ResultPathRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            ResultPathRefusal::Invalid => "invalid",
            ResultPathRefusal::NotEpub => "not-epub",
            ResultPathRefusal::Source => "source",
            ResultPathRefusal::OpenInTab => "open-in-tab",
        }
    }
}

/// `EpubResultPathCheck`: `{ ok: true }` or `{ ok: false, reason }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultPathCheck {
    Ok,
    Refused(ResultPathRefusal),
}

impl ResultPathCheck {
    pub fn to_json(self) -> Value {
        let mut out = Map::new();
        match self {
            ResultPathCheck::Ok => {
                out.insert("ok".into(), Value::Bool(true));
            }
            ResultPathCheck::Refused(reason) => {
                out.insert("ok".into(), Value::Bool(false));
                out.insert("reason".into(), Value::from(reason.as_str()));
            }
        }
        Value::Object(out)
    }
}

/// `process.platform === 'win32' || process.platform === 'darwin'`
pub fn default_case_insensitive() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

/// `pathKey(path, caseInsensitive)`: one spelling per path: resolved,
/// case-folded where the disk ignores case. `None` is the platform's default.
pub fn path_key(path: &str, case_insensitive: Option<bool>) -> String {
    let resolved = resolve(&[path]);
    if case_insensitive.unwrap_or_else(default_case_insensitive) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// `samePath(a, b, caseInsensitive)`
pub fn same_path(a: &str, b: &str, case_insensitive: Option<bool>) -> bool {
    path_key(a, case_insensitive) == path_key(b, case_insensitive)
}

/// `checkResultPath(path, context)`: whether a result book may be written to
/// `path`; `None` is a `path` that is no string.
pub fn check_result_path(
    path: Option<&str>,
    context: &mut ResultPathContext<'_>,
) -> ResultPathCheck {
    let Some(path) = path else {
        return ResultPathCheck::Refused(ResultPathRefusal::Invalid);
    };
    if path.is_empty() || path.encode_utf16().count() > 4096 || !is_absolute(path) {
        return ResultPathCheck::Refused(ResultPathRefusal::Invalid);
    }
    if !js_regex!(r"\.epub$", "i").test(path) {
        return ResultPathCheck::Refused(ResultPathRefusal::NotEpub);
    }
    if same_path(path, context.source_path, context.case_insensitive) {
        return ResultPathCheck::Refused(ResultPathRefusal::Source);
    }
    if (context.is_open_in_tab)(path) {
        return ResultPathCheck::Refused(ResultPathRefusal::OpenInTab);
    }
    ResultPathCheck::Ok
}
