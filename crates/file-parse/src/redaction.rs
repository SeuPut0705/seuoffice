//! What the redactors share: `sanitizeLabel` and `placeholderSource` of
//! packages/agent-core/src/redact-core.ts, `REDACT_NAMESPACES` and `REDACT_EL` of
//! redact-range.ts, and the message of packages/file-parse/src/redaction-error.ts.

use jscompat::{js_regex, trim, truthy};

/// `REDACT_NAMESPACES`: the product's own namespace, then the one written
/// before it took its own names (`OLD_REDACT_NS`); readers take both.
pub const REDACT_NAMESPACES: [&str; 2] = [
    "https://github.com/SeuPut0705/seuoffice/redaction/2026",
    "https://genspark.ai/genoffice/redaction/2026",
];
pub const REDACT_EL: &str = "go:redact";

const OPEN: &str = "{{";
const CLOSE: &str = "}}";

/// Counted in UTF-16 code units, as `slice` counts.
const MAX_LABEL_LENGTH: usize = 40;

/// The `message` of `new RedactionMarkError(detail)`.
pub fn redaction_error(detail: &str) -> String {
    format!("Redaction marks in this file could not be processed ({detail}); the file was not read")
}

/// `sanitizeLabel(raw)` with the default options; no reader here passes
/// `forComment`.
///
/// Keep at most 40 UTF-16 units, without splitting a code point. The original
/// TypeScript split is a reported defect, recorded in the parity ledger.
pub fn sanitize_label(raw: &str) -> String {
    let stripped = js_regex!(r#"[{}<>="']"#).replace_all(raw, |_| String::new());
    let spaced = js_regex!(r"\s+").replace_all(&stripped, |_| " ".to_owned());
    let text = trim(&spaced);
    let mut units = 0;
    let mut cut = text.len();
    for (at, c) in text.char_indices() {
        if units + c.len_utf16() > MAX_LABEL_LENGTH {
            cut = at;
            break;
        }
        units += c.len_utf16();
    }
    trim(&text[..cut]).to_owned()
}

/// `placeholderSource(label)`.
pub fn placeholder_source(label: &str) -> String {
    let label = sanitize_label(label);
    format!("{OPEN}{}{CLOSE}", truthy(Some(&label)).unwrap_or("private"))
}
