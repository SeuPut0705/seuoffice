//! `apps/pdf/src/main/ocr.ts`: the system-OCR bridge of the PDF viewer
//! (issue #119). It recognizes one rendered page image through the platform
//! helper binaries shared with pdf2docx (macOS Vision, Windows.Media.Ocr),
//! with the engine factories of `packages/pdf2docx/src/ocr-vision.ts`
//! (`createVisionOcrEngine`, `createWindowsOcrEngine`, the spawn wrapper they
//! share).
//!
//! The module-level `ocrEngine` memo is an [`OcrBridge`] the caller keeps.

use super::child::{Ended, capture};
use super::font_locate::Platform;

use jscompat::node_path::host;
use jscompat::{JsObject, JsonValue, json_parse};
use std::time::Duration;

/// helper output caps: a page render is a few MB, JSON a few hundred KB
const HELPER_MAX_BUFFER: usize = 64 * 1024 * 1024;
const HELPER_TIMEOUT_MS: u64 = 30_000;

/// What the TypeScript throws (`error.message`); a `TypeError` of a helper
/// line that has not the shape the helpers write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

/// What `ocr.ts` reads from the process and from its own location
#[derive(Debug, Clone)]
pub struct OcrEnv {
    /// `process.platform`
    pub platform: Platform,
    /// `dirname(fileURLToPath(import.meta.url))`: `apps/pdf/src/main`
    pub here: String,
    /// `process.resourcesPath`, `None` outside Electron
    pub resources_path: Option<String>,
}

/// An `OcrEngine` the spawn wrapper builds: the helper to run
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperEngine {
    helper_path: String,
}

/// The memo of `ensureOcrEngine`: not looked up yet, none, or an engine
#[derive(Debug, Default)]
pub struct OcrBridge {
    engine: Option<Option<HelperEngine>>,
}

fn exists(path: &str) -> bool {
    std::fs::metadata(path).is_ok()
}

/// `createVisionOcrEngine(helperPath)`
fn create_vision_engine(platform: Platform, helper_path: &str) -> Option<HelperEngine> {
    if platform != Platform::Darwin || !exists(helper_path) {
        return None;
    }
    Some(HelperEngine {
        helper_path: helper_path.to_owned(),
    })
}

/// `createWindowsOcrEngine(helperPath)`
fn create_windows_engine(platform: Platform, helper_path: &str) -> Option<HelperEngine> {
    if platform != Platform::Win32 || !exists(helper_path) {
        return None;
    }
    Some(HelperEngine {
        helper_path: helper_path.to_owned(),
    })
}

fn type_error(of: &str, key: &str) -> Thrown {
    Thrown(format!("Cannot read properties of {of} (reading '{key}')"))
}

/// `value[key]` where JavaScript throws on `null` and `undefined`
fn read(value: Option<&JsonValue>, key: &str) -> Result<Option<JsonValue>, Thrown> {
    match value {
        None => Err(type_error("undefined", key)),
        Some(JsonValue::Null) => Err(type_error("null", key)),
        Some(v) => Ok(v.get(key).map(std::borrow::Cow::into_owned)),
    }
}

/// `toRect(b)` read as `{ x0: b[0], y0: b[1], x1: b[2], y1: b[3] }`, in the
/// order the caller writes it
fn rect_parts(b: Option<&JsonValue>) -> Result<Vec<Option<JsonValue>>, Thrown> {
    (0..4).map(|k| read(b, &k.to_string())).collect()
}

/// an array element: `undefined` is written `null`
fn element(v: Option<JsonValue>) -> JsonValue {
    v.unwrap_or(JsonValue::Null)
}

impl HelperEngine {
    /// `createHelperOcrEngine(helperPath)(png)`: `None` is `null`
    fn recognize(&self, png: &[u8]) -> Result<Option<JsonValue>, Thrown> {
        let run = capture(
            &self.helper_path,
            &[],
            &[],
            Some(png),
            Duration::from_millis(HELPER_TIMEOUT_MS),
            HELPER_MAX_BUFFER,
        );
        if run.ended != Ended::Exited(Some(0)) {
            return Ok(None);
        }
        // defense in depth: .NET Framework consoles can prepend a UTF-8 BOM
        let text = String::from_utf8_lossy(&run.stdout);
        let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
        let Ok(parsed) = json_parse(text) else {
            return Ok(None);
        };
        let lines = read(Some(&parsed), "lines")?;
        match lines {
            Some(JsonValue::Array(_)) => Ok(lines),
            _ => Ok(None),
        }
    }
}

fn line_out(l: &JsonValue) -> Result<JsonValue, Thrown> {
    let mut out: JsObject<JsonValue> = JsObject::new();
    if let Some(text) = read(Some(l), "t")? {
        out.set("text", text);
    }
    if let Some(confidence) = read(Some(l), "c")? {
        out.set("confidence", confidence);
    }
    let b = read(Some(l), "b")?;
    out.set(
        "box",
        JsonValue::Array(rect_parts(b.as_ref())?.into_iter().map(element).collect()),
    );
    if let Some(chars) = read(Some(l), "chars")?
        && chars.truthy()
    {
        let JsonValue::Array(items) = &chars else {
            return Err(Thrown("l.chars.map is not a function".to_owned()));
        };
        let mut mapped = Vec::with_capacity(items.len());
        for c in items {
            let mut item: JsObject<JsonValue> = JsObject::new();
            if let Some(text) = read(Some(c), "t")? {
                item.set("text", text);
            }
            let cb = read(Some(c), "b")?;
            item.set(
                "box",
                JsonValue::Array(rect_parts(cb.as_ref())?.into_iter().map(element).collect()),
            );
            mapped.push(JsonValue::Object(item));
        }
        out.set("chars", JsonValue::Array(mapped));
    }
    Ok(JsonValue::Object(out))
}

impl OcrBridge {
    pub fn new() -> Self {
        OcrBridge { engine: None }
    }

    fn ensure_engine(&mut self, env: &OcrEnv) -> Option<&HelperEngine> {
        if self.engine.is_none() {
            let darwin = env.platform == Platform::Darwin;
            let helper = if darwin { "vision-ocr" } else { "win-ocr.exe" };
            let mut candidates: Vec<String> = Vec::new();
            if let Some(resources) = env.resources_path.as_deref().filter(|r| !r.is_empty()) {
                candidates.push(host::join(&[resources, "ocr", helper]));
            }
            candidates.push(host::join(&[
                &env.here,
                "../../../../packages/pdf2docx/ocr-helper",
                helper,
            ]));
            let mut found = None;
            for path in candidates {
                let engine = if darwin {
                    create_vision_engine(env.platform, &path)
                } else {
                    create_windows_engine(env.platform, &path)
                };
                if engine.is_some() {
                    found = engine;
                    break;
                }
            }
            self.engine = Some(found);
        }
        self.engine.as_ref().and_then(Option::as_ref)
    }

    /// PNG (base64) -> OCR lines; `None` only when the platform has no engine (callers
    /// stop trying), `[]` when recognition failed for this image (callers move on)
    pub fn ocr_page_png(
        &mut self,
        env: &OcrEnv,
        png_base64: &str,
    ) -> Result<Option<Vec<JsonValue>>, Thrown> {
        let Some(engine) = self.ensure_engine(env) else {
            return Ok(None);
        };
        let png = jscompat::buffer_from_base64(png_base64);
        // the helpers ignore the page size hint
        let Some(JsonValue::Array(lines)) = engine.recognize(&png)? else {
            return Ok(Some(Vec::new()));
        };
        lines
            .iter()
            .map(line_out)
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    }
}
