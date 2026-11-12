//! The four commands of the odt engine (`crates/odt-engine/C3-PLAN.md`, "The
//! wire"): what `@seuoffice/odt-engine` and `tools/odt-diff` call. They are
//! product calls, so the docx model values they read inside (`parseDocx` of
//! the edited docx) are read as the TypeScript reads them, as `invoke` does.

use jscompat::{JsMap, reading_leniently};
use odt_engine::assemble::{self, RenderedObject, SavedOdt};
use odt_engine::core::{HostNow, OdtError};
use serde::Deserialize;
use serde_json::{Value, json};

/// The host's clock: `Date.now()` and `getTimezoneOffset()`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNow {
    ms: f64,
    offset_minutes: f64,
}

impl From<WireNow> for HostNow {
    fn from(now: WireNow) -> Self {
        HostNow {
            ms: now.ms,
            offset_minutes: now.offset_minutes,
        }
    }
}

/// One rendered object of `docxToOdt`: its PNG is blob `blob` of the request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireRendered {
    width_emu: f64,
    height_emu: f64,
    blob: usize,
}

fn failure(error: OdtError) -> Value {
    let (code, message) = error.code_and_message();
    json!({ "error": { "code": code, "message": message } })
}

fn invalid(message: impl ToString) -> Value {
    json!({ "error": { "code": "invalid_request", "message": message.to_string() } })
}

fn blob<'a>(blobs: &[&'a [u8]], index: usize) -> Result<&'a [u8], Value> {
    blobs
        .get(index)
        .copied()
        .ok_or_else(|| invalid(format!("blob {index} is missing")))
}

/// `odtToDocx`: blob 0 the ODT; `now` dates the bridge docx's entries. Reply
/// `{ report }`, blob 0 the docx, blob 1 the bridge JSON.
pub fn odt_to_docx(blobs: &[&[u8]], now: WireNow, reply_blobs: &mut Vec<Vec<u8>>) -> Value {
    let odt = match blob(blobs, 0) {
        Ok(odt) => odt,
        Err(reply) => return reply,
    };
    match reading_leniently(|| assemble::odt_to_docx(odt, now.into())) {
        Ok(result) => match serde_json::to_vec(&result.bridge) {
            Ok(bridge) => {
                reply_blobs.push(result.docx_bytes);
                reply_blobs.push(bridge);
                json!({ "report": result.report })
            }
            Err(error) => invalid(error),
        },
        Err(error) => failure(error),
    }
}

/// `saveOdt`: blobs the ODT, the bridge JSON, the edited docx. Reply
/// `{ unchanged }`, blob 0 the ODT unless unchanged.
pub fn save_odt(blobs: &[&[u8]], now: WireNow, reply_blobs: &mut Vec<Vec<u8>>) -> Value {
    let inputs = blob(blobs, 0).and_then(|odt| Ok((odt, blob(blobs, 1)?, blob(blobs, 2)?)));
    let (odt, bridge, edited) = match inputs {
        Ok(inputs) => inputs,
        Err(reply) => return reply,
    };
    let bridge = match serde_json::from_slice(bridge) {
        Ok(bridge) => bridge,
        Err(error) => return invalid(format!("bridge: {error}")),
    };
    match reading_leniently(|| assemble::save_odt(odt, &bridge, edited, now.into())) {
        Ok(SavedOdt::Unchanged) => json!({ "unchanged": true }),
        Ok(SavedOdt::Bytes(bytes)) => {
            reply_blobs.push(bytes);
            json!({ "unchanged": false })
        }
        Err(error) => failure(error),
    }
}

/// `docxToOdt`: blob 0 the docx, `rendered` naming the blobs of the PNGs.
/// Reply `{ report }`, blob 0 the ODT.
pub fn docx_to_odt(
    blobs: &[&[u8]],
    rendered: Vec<(String, WireRendered)>,
    now: WireNow,
    reply_blobs: &mut Vec<Vec<u8>>,
) -> Value {
    let docx = match blob(blobs, 0) {
        Ok(docx) => docx,
        Err(reply) => return reply,
    };
    let mut objects = JsMap::new();
    for (key, object) in rendered {
        let png = match blob(blobs, object.blob) {
            Ok(png) => png.to_vec(),
            Err(reply) => return reply,
        };
        objects.set(
            key,
            RenderedObject {
                png,
                width_emu: object.width_emu,
                height_emu: object.height_emu,
            },
        );
    }
    match reading_leniently(|| assemble::docx_to_odt(docx, &objects, now.into())) {
        Ok(result) => {
            reply_blobs.push(result.odt_bytes);
            json!({ "report": result.report })
        }
        Err(error) => failure(error),
    }
}

/// `odtToText`: blob 0 the ODT. Reply `{ text }`.
pub fn odt_to_text(blobs: &[&[u8]]) -> Value {
    match blob(blobs, 0).map(|odt| reading_leniently(|| assemble::odt_to_text(odt))) {
        Ok(Ok(text)) => json!({ "text": text }),
        Ok(Err(error)) => failure(error),
        Err(reply) => reply,
    }
}
