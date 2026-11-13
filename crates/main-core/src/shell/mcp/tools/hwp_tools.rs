//! `apps/shell/src/main/mcp/tools/hwp-tools.ts`: HWP reading. The registry's
//! `hwp` family exposes read-only MCP access (`mcp.read`, no session, no
//! generation). An agent reads the text of a Hangul document directly from
//! disk, through the same engine the HWP editor runs. Like read_pdf this is
//! headless and always registered. Editing an HWP document is done in the
//! editor, by its own AI panel.
//!
//! `hwpToText` of `@seuoffice/file-parse` has no Rust port yet (engine
//! waiting): the tool reaches it through an [`HwpTextReader`] the host
//! implements. What is ported is the judgment around it: the path checks, the
//! file read and the window of text one answer holds ([`hwp_text_window`],
//! whose offsets count UTF-16 code units as `String.length` does).

use std::rc::Rc;

use jscompat::node_path::host::{basename, extname, is_absolute};
use jscompat::{JsObject, JsonValue, number_to_string};

use super::session_tools::string_or_empty;
use crate::node_fs::NodeError;
use crate::packages::zod::z;
use crate::pdf::generated_output::exists_sync;
use crate::pdf::node_io::read_file_bytes;
use crate::shell::mcp::mcp_server::McpToolDefinition;

/// `hwpToText(bytes)`: the text of an HWP / HWPX file. `Err` is the message of
/// what it throws (a damaged file, a password-protected one).
pub trait HwpTextReader {
    fn hwp_to_text(&self, bytes: &[u8]) -> Result<String, String>;
}

/// `HWP_EXTS`
const HWP_EXTS: [&str; 2] = [".hwp", ".hwpx"];

/// `HWP_MAX_CHARS`: hard cap on returned text so one huge document cannot flood
/// the agent's context
pub const HWP_MAX_CHARS: f64 = 80_000.0;

/// What [`hwp_text_window`] answers: `{ text, totalChars, offset, truncated,
/// nextOffset? }`.
#[derive(Debug, Clone, PartialEq)]
pub struct HwpTextWindow {
    pub text: String,
    pub total_chars: f64,
    pub offset: f64,
    /// there is more after the window
    pub truncated: bool,
    /// where to go on, when `truncated`
    pub next_offset: Option<f64>,
}

impl HwpTextWindow {
    /// the window as the JSON object the TypeScript's literal writes
    pub fn to_json(&self) -> JsonValue {
        let mut out = JsObject::new();
        out.set("text", JsonValue::String(self.text.clone()));
        out.set("totalChars", JsonValue::Number(self.total_chars));
        out.set("offset", JsonValue::Number(self.offset));
        out.set("truncated", JsonValue::Bool(self.truncated));
        if let Some(next) = self.next_offset {
            out.set("nextOffset", JsonValue::Number(next));
        }
        JsonValue::Object(out)
    }
}

/// `hwpTextWindow(text, offset)`: one window of a document's text. `truncated`
/// says there is more after it, and `nextOffset` is where to go on.
pub fn hwp_text_window(text: &str, offset: f64) -> HwpTextWindow {
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = units.len() as f64;
    // `Math.trunc(offset) || 0`: NaN and -0 are 0
    let truncated_offset = offset.trunc();
    let truncated_offset = if truncated_offset == 0.0 || truncated_offset.is_nan() {
        0.0
    } else {
        truncated_offset
    };
    let start = truncated_offset.max(0.0).min(length);
    let end = length.min(start + HWP_MAX_CHARS);
    HwpTextWindow {
        text: String::from_utf16_lossy(&units[start as usize..end as usize]),
        total_chars: length,
        offset: start,
        truncated: end < length,
        next_offset: (end < length).then_some(end),
    }
}

/// What [`read_hwp_file`] fails with: the file could not be read (Node's
/// error, with its `code`), or the engine refused it (what `hwpToText` threw).
#[derive(Debug, Clone, PartialEq)]
pub enum HwpReadError {
    File(NodeError),
    Engine(String),
}

impl HwpReadError {
    /// the message of the `Error`
    pub fn message(&self) -> &str {
        match self {
            HwpReadError::File(error) => &error.message,
            HwpReadError::Engine(message) => message,
        }
    }
}

/// `readHwpFile(filePath)`: the text of an HWP / HWPX file; failures come back
/// as one plain tool error.
pub fn read_hwp_file(reader: &dyn HwpTextReader, file_path: &str) -> Result<String, HwpReadError> {
    let bytes = read_file_bytes(file_path).map_err(HwpReadError::File)?;
    reader.hwp_to_text(&bytes).map_err(HwpReadError::Engine)
}

/// `createHwpTools()`: `read_hwp`, over the host's text reader
pub fn create_hwp_tools<'h>(reader: Rc<dyn HwpTextReader + 'h>) -> Vec<McpToolDefinition<'h>> {
    vec![McpToolDefinition {
        name: "read_hwp".to_owned(),
        description: format!(
            "Read the text of a Hangul word processor document (.hwp or .hwpx): paragraphs as \
             lines, data tables as rows with cells joined by \" | \". The text is what is saved on \
             disk. Long documents are returned {} characters at a time; pass the \
             `nextOffset` of one answer as `offset` to read on. A password-protected document \
             cannot be read.",
            number_to_string(HWP_MAX_CHARS)
        ),
        input_schema: Some(z::shape(vec![
            (
                "path",
                z::string().describe("absolute path to a .hwp or .hwpx file"),
            ),
            (
                "offset",
                z::number()
                    .int()
                    .min(0.0)
                    .optional()
                    .describe("character to start from; default 0"),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if !HWP_EXTS.contains(&extname(&file_path).to_lowercase().as_str()) {
                return Err("path must point to a .hwp or .hwpx file".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }
            let text = read_hwp_file(&*reader, &file_path).map_err(|e| e.message().to_owned())?;
            let offset = match args.get("offset").as_deref() {
                Some(JsonValue::Number(offset)) => *offset,
                _ => 0.0,
            };
            let mut out = JsObject::new();
            out.set("path", JsonValue::String(file_path.clone()));
            out.set("name", JsonValue::String(basename(&file_path, None)));
            if let JsonValue::Object(window) = hwp_text_window(&text, offset).to_json() {
                out.assign(&window);
            }
            Ok(Some(JsonValue::Object(out)))
        }),
    }]
}
