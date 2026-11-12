//! Parts a drawing points at through a relationship: media, external textbox
//! parts and charts.

use jscompat::{JsMap, JsNum, JsObject, Radix, base64, js_regex, math_round, parse_int};
use ooxml_pkg::{Package, Part};

use super::EMU_PER_PX;
use crate::chart::parse_chart_part_xml;
use crate::model::ChartDisplay;
use crate::package::{RelInfo, Thrown, part_text, resolve_relationship_target_path};
use crate::theme::ThemeColors;
use crate::vml::shape::encode_uri_component;

/// `LAZY_MEDIA_SCHEME` of lazy-media.ts.
pub const LAZY_MEDIA_SCHEME: &str = "genoffice-docx-media";

/// `MAGIC` of lazy-media.ts.
const LAZY_MEDIA_MAGIC: &[u8] = b"GENOFFICE-LAZY-MEDIA\n";

/// `LAZY_MEDIA_PLACEHOLDER_BYTES` of lazy-media.ts: the magic, a sha256 in hex
/// and a line feed.
pub const LAZY_MEDIA_PLACEHOLDER_BYTES: usize = LAZY_MEDIA_MAGIC.len() + 64 + 1;

/// `lazyMediaHashOf` of lazy-media.ts: the hash a placeholder part names. The
/// TypeScript decodes the bytes as windows-1252, which maps no byte above
/// 0x7F to ASCII, so the bytes are compared as they are.
pub fn lazy_media_hash_of(bytes: &[u8]) -> Option<&str> {
    if bytes.len() != LAZY_MEDIA_PLACEHOLDER_BYTES
        || !bytes.starts_with(LAZY_MEDIA_MAGIC)
        || !bytes.ends_with(b"\n")
    {
        return None;
    }
    let hash = &bytes[LAZY_MEDIA_MAGIC.len()..LAZY_MEDIA_MAGIC.len() + 64];
    if !hash
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return None;
    }
    std::str::from_utf8(hash).ok()
}

/// `lazyMediaUrl` of lazy-media.ts, for a hash `lazy_media_hash_of` accepted.
pub fn lazy_media_url(hash: &str, part_path: &str) -> String {
    let path: Vec<String> = part_path.split('/').map(encode_uri_component).collect();
    format!("{LAZY_MEDIA_SCHEME}://{hash}/{}", path.join("/"))
}

/// `mediaPartSrc`: the picture URL of a media part. A lazy-media placeholder
/// points at the source document's part, and its hash joins `lazy_hashes`
/// (`lazyHashesByZip.get(zip)`, a Set); anything else inlines the bytes.
///
/// The TypeScript reads the size the zip declares for the part; that is the
/// length of the bytes of every part JSZip can inflate, so the bytes'
/// length stands for it here.
pub fn media_part_src(
    file: &Part,
    part_path: &str,
    mime: &str,
    lazy_hashes: &mut Vec<String>,
) -> Result<String, Thrown> {
    let bytes = file.bytes().map_err(|error| error.to_string())?;
    if bytes.len() == LAZY_MEDIA_PLACEHOLDER_BYTES
        && let Some(hash) = lazy_media_hash_of(bytes)
    {
        if !lazy_hashes.iter().any(|seen| seen == hash) {
            lazy_hashes.push(hash.to_owned());
        }
        return Ok(lazy_media_url(hash, part_path));
    }
    Ok(format!("data:{mime};base64,{}", base64(bytes)))
}

/// `externalTxbxParts`: the parts `<wps:txbx r:txbx="…"/>` points at (older
/// Word builds keep a textbox's paragraphs in word/txbx*.xml), by
/// relationship id.
pub fn external_txbx_parts(
    document_xml: &str,
    zip: &Package,
    rels: &JsMap<RelInfo>,
    source_path: Option<&str>,
) -> Result<JsMap<String>, Thrown> {
    let source_path = source_path.unwrap_or("word/document.xml");
    let mut out = JsMap::new();
    for found in js_regex!(r#"<wps:txbx\b[^>]*\br:txbx="([^"]+)""#).find_iter(document_xml) {
        let r_id = found.get(1).unwrap_or("");
        if out.has(r_id) {
            continue;
        }
        let Some(rel) = rels.get(r_id) else {
            continue;
        };
        if rel.target_mode.as_deref() == Some("External") {
            continue;
        }
        let Some(path) = resolve_relationship_target_path(source_path, &rel.target) else {
            continue;
        };
        if let Some(text) = part_text(zip, &path)? {
            out.set(r_id, text.to_owned());
        }
    }
    Ok(out)
}

/// `relPartPath`: the part a document relationship names, `None` (null) for
/// an external or missing one.
pub fn rel_part_path(
    rels: &JsMap<RelInfo>,
    source_path: Option<&str>,
    r_id: Option<&str>,
) -> Option<String> {
    let rel = r_id
        .filter(|r_id| !r_id.is_empty())
        .and_then(|r_id| rels.get(r_id))?;
    if rel.target_mode.as_deref() == Some("External") {
        return None;
    }
    resolve_relationship_target_path(source_path.unwrap_or("word/document.xml"), &rel.target)
}

/// The fields of `BuildContext` `extractChart` reads and writes.
pub struct ChartContext<'a> {
    pub zip: &'a Package,
    pub rels: &'a JsMap<RelInfo>,
    pub source_path: Option<&'a str>,
    pub theme_colors: Option<&'a ThemeColors>,
    /// `ctx.chartParts`: the original XML of each classic chart part read, by
    /// part path.
    pub chart_parts: &'a mut JsObject<String>,
}

/// `extractChart`: the chart part a chart drawing paragraph references,
/// parsed, at the wp:extent size. A classic (c:) part's XML is kept in
/// `chart_parts` so data edits can be patched into it at save time.
pub fn extract_chart(
    xml: &str,
    ctx: &mut ChartContext<'_>,
) -> Result<Option<ChartDisplay>, Thrown> {
    let r_id = js_regex!(r#"<cx?:chart [^>]*r:id="([^"]+)""#)
        .exec(xml)
        .and_then(|found| found.get(1));
    let Some(rel) = r_id.and_then(|r_id| ctx.rels.get(r_id)) else {
        return Ok(None);
    };
    if rel.target_mode.as_deref() == Some("External") {
        return Ok(None);
    }
    let Some(path) = resolve_relationship_target_path(
        ctx.source_path.unwrap_or("word/document.xml"),
        &rel.target,
    ) else {
        return Ok(None);
    };
    let Some(part_xml) = part_text(ctx.zip, &path)? else {
        return Ok(None);
    };
    let mut display = parse_chart_part_xml(part_xml, &path, ctx.theme_colors)?;
    if let Some(display) = display.as_mut() {
        // chartex (cx:) parts are display-only degrades: the data-edit patcher
        // speaks classic c: syntax, so keeping them out makes edits no-ops
        // instead of corruption
        if !part_xml.contains("<cx:chartSpace") {
            ctx.chart_parts.set(path.as_str(), part_xml.to_owned());
        }
        let extent_tag = js_regex!(r"<wp:extent[^>]*\/?>")
            .exec(xml)
            .map_or("", |found| found.as_str());
        let size = |pattern: &jscompat::JsRegex| {
            parse_int(
                pattern
                    .exec(extent_tag)
                    .and_then(|found| found.get(1))
                    .unwrap_or(""),
                Radix::Ten,
            )
        };
        let cx = size(js_regex!(r#"\bcx\s*=\s*["'](\d+)["']"#));
        let cy = size(js_regex!(r#"\bcy\s*=\s*["'](\d+)["']"#));
        if cx.is_finite() && cx > 0.0 {
            display.width_px.set(JsNum(math_round(cx / EMU_PER_PX)));
        }
        if cy.is_finite() && cy > 0.0 {
            display.height_px.set(JsNum(math_round(cy / EMU_PER_PX)));
        }
    }
    Ok(display)
}
