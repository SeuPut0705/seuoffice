//! Parts a drawing points at through a relationship: media, external textbox
//! parts, charts and OLE previews.

use jscompat::{JsMap, JsNum, JsObject, Radix, base64, js_regex, math_round, parse_int, truthy};
use ooxml_pkg::{Package, Part};

use super::EMU_PER_PX;
use super::host::MediaEnv;
use crate::chart::parse_chart_part_xml;
use crate::image_kinds::{is_metafile_mime, is_tiff_mime};
use crate::lazy_media::{LAZY_MEDIA_PLACEHOLDER_BYTES, lazy_media_hash_of, lazy_media_url};
use crate::model::{Block, BlockImageAlign, ChartDisplay, SharedStr};
use crate::numbering::NumberingDef;
use crate::package::{
    RelInfo, Thrown, canonical_part_text, content_types_of, parse_rels,
    resolve_relationship_target_path,
};
use crate::parse::text::BuildContext;
use crate::scan::BodyElement;
use crate::theme::ThemeColors;

/// `IMAGE_MIME[ext]` of the table's own keys (`ownValue`).
fn image_mime_of_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "emf" => "image/emf",
        "wmf" => "image/wmf",
        "emz" => "image/x-emz",
        "wmz" => "image/x-wmz",
        "tif" | "tiff" => "image/tiff",
        _ => return None,
    })
}

/// `imagePartMime`: the mime of an image part, from the extension table
/// first, then from [Content_Types].xml (an Override of the part, a Default of
/// the extension), which covers parts with opaque extensions (media/*.bin).
pub fn image_part_mime(
    zip: &Package,
    path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<String>, Thrown> {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    if let Some(from_ext) = image_mime_of_extension(&ext) {
        return Ok(Some(from_ext.to_owned()));
    }
    let types = media.content_types(|| content_types_of(zip))?;
    let from_part = types
        .overrides
        .get(&format!("/{path}"))
        .or_else(|| types.defaults.get(&ext));
    Ok(from_part.filter(|mime| mime.starts_with("image/")).cloned())
}

/// `mediaPartSrc`: the picture URL of a media part. A lazy-media placeholder
/// points at the source document's part, and its hash joins the lazy hashes
/// of the zip; anything else inlines the bytes.
///
/// The TypeScript reads the size the zip declares for the part; that is the
/// length of the bytes of every part JSZip can inflate, so the bytes'
/// length stands for it here.
pub fn media_part_src(
    file: &Part,
    part_path: &str,
    mime: &str,
    media: &MediaEnv<'_>,
) -> Result<String, Thrown> {
    let bytes = file.bytes().map_err(|error| error.to_string())?;
    if bytes.len() == LAZY_MEDIA_PLACEHOLDER_BYTES
        && let Some(hash) = lazy_media_hash_of(bytes)
    {
        media.add_lazy_hash(hash);
        return Ok(lazy_media_url(hash, part_path));
    }
    Ok(format!("data:{mime};base64,{}", base64(bytes)))
}

/// `readMediaPartDataUrl`: the data URL of an image part. EMF and WMF go
/// through the host's converter, TIFF through its re-encoder.
pub fn read_media_part_data_url(
    zip: &Package,
    part_path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<SharedStr>, Thrown> {
    let Some(file) = zip.file(part_path) else {
        return Ok(None);
    };
    let Some(mime) = image_part_mime(zip, part_path, media)? else {
        return Ok(None);
    };
    if is_metafile_mime(Some(&mime)) {
        let bytes = file.bytes().map_err(|error| error.to_string())?;
        return Ok(media
            .host
            .metafile_to_data_url(bytes, &mime)
            .map(SharedStr::from));
    }
    if is_tiff_mime(Some(&mime)) {
        let bytes = file.bytes().map_err(|error| error.to_string())?;
        return Ok(media.host.tiff_to_data_url(bytes).map(SharedStr::from));
    }
    media_part_src(file, part_path, &mime, media).map(|src| Some(SharedStr::from(src)))
}

/// `mediaPartDataUrl`: one string per media part, so a picture anchored on
/// thousands of paragraphs does not hold thousands of base64 copies. A hit
/// hands out the string the first read made, not a copy of it.
pub fn media_part_data_url(
    zip: &Package,
    part_path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<SharedStr>, Thrown> {
    if let Some(cached) = media.cached_data_url(part_path) {
        return Ok(cached);
    }
    let data_url = read_media_part_data_url(zip, part_path, media)?;
    media.cache_data_url(part_path, data_url.clone());
    Ok(data_url)
}

/// `mediaDataUrl`: an image relationship id as a data URL (embedded parts
/// only); `source_path` is the part that owns the relationship.
pub fn media_data_url(
    zip: &Package,
    rels: &JsMap<RelInfo>,
    r_id: &str,
    source_path: &str,
    media: &MediaEnv<'_>,
) -> Result<Option<SharedStr>, Thrown> {
    let Some(rel) = rels.get(r_id) else {
        return Ok(None);
    };
    if rel.target_mode.as_deref() == Some("External") {
        return Ok(None);
    }
    match resolve_relationship_target_path(source_path, &rel.target) {
        Some(part_path) => media_part_data_url(zip, &part_path, media),
        None => Ok(None),
    }
}

/// `resolvePicBullets`: the media data URL of each w:numPicBullet on the
/// levels that reference it.
pub fn resolve_pic_bullets(
    zip: &Package,
    numbering: &mut JsMap<NumberingDef>,
    pic_bullets: &[(JsNum, String)],
    media: &MediaEnv<'_>,
) -> Result<(), Thrown> {
    if pic_bullets.is_empty() {
        return Ok(());
    }
    let rels = parse_rels(zip, "word/_rels/numbering.xml.rels")?;
    let mut src_by_id: Vec<(JsNum, SharedStr)> = Vec::new();
    for (id, r_id) in pic_bullets {
        if let Some(src) = media_data_url(zip, &rels, r_id, "word/numbering.xml", media)?
            && !src.is_empty()
        {
            src_by_id.push((*id, src));
        }
    }
    for def in numbering.values_mut() {
        for level in def.levels.values_mut() {
            let Some(id) = level.pic_bullet_id.as_ref().copied() else {
                continue;
            };
            if level
                .pic_bullet_src
                .as_ref()
                .is_some_and(|src| !src.is_empty())
            {
                continue;
            }
            if let Some((_, src)) = src_by_id.iter().find(|(known, _)| known.0 == id.0) {
                level.pic_bullet_src.set(src.to_string());
            }
        }
    }
    Ok(())
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
        if let Some(text) = canonical_part_text(zip, &path)? {
            out.set(r_id, text.into_owned());
        }
    }
    Ok(out)
}

/// `/^https?:\/\//i.test(target)`
fn is_http_url(target: &str) -> bool {
    js_regex!(r"^https?:\/\/", "i").test(target)
}

/// `tableBlipMedia`: the blip and VML image rIds found inside w:tbl (and in
/// the table of a w:sdt) as data URLs, an external one as its target.
pub fn table_blip_media(
    elements: &[BodyElement<'_>],
    document_xml: &str,
    zip: &Package,
    rels: &JsMap<RelInfo>,
    source_path: &str,
    media: &MediaEnv<'_>,
) -> Result<JsMap<SharedStr>, Thrown> {
    let mut out = JsMap::new();
    let mut r_ids: Vec<String> = Vec::new();
    for el in elements {
        if el.name != "w:tbl" && el.name != "w:sdt" {
            continue;
        }
        let mut slice = &document_xml[el.start..el.end];
        if el.name == "w:sdt" {
            let Some(from) = slice.find("<w:tbl") else {
                continue;
            };
            let end = slice.rfind("</w:tbl>");
            // slice(from, lastIndexOf('</w:tbl>') + 8): a missing close is -1 + 8
            let to = end.map_or(7, |end| end + "</w:tbl>".len());
            slice = slice.get(from..to).unwrap_or("");
        }
        for found in
            js_regex!(r#"<a:blip[^>]*r:(?:embed|link)\s*=\s*["']([^"']+)["']"#).find_iter(slice)
        {
            push_unique(&mut r_ids, found.get(1).unwrap_or(""));
        }
        // legacy VML pictures and OLE previews inside cells (w:pict / w:object)
        for found in js_regex!(r#"<v:imagedata[^>]*r:id\s*=\s*["']([^"']+)["']"#).find_iter(slice) {
            push_unique(&mut r_ids, found.get(1).unwrap_or(""));
        }
    }
    for r_id in &r_ids {
        let Some(rel) = rels.get(r_id) else {
            continue;
        };
        if rel.target_mode.as_deref() == Some("External") || is_http_url(&rel.target) {
            out.set(r_id.as_str(), SharedStr::from(rel.target.as_str()));
            continue;
        }
        if let Some(data_url) = media_data_url(zip, rels, r_id, source_path, media)?
            && !data_url.is_empty()
        {
            out.set(r_id.as_str(), data_url);
        }
    }
    Ok(out)
}

/// A `Set` add.
fn push_unique(set: &mut Vec<String>, value: &str) {
    if !set.iter().any(|known| known == value) {
        set.push(value.to_owned());
    }
}

/// `source_path` of a context: `ctx.sourcePath ?? 'word/document.xml'`.
fn source_path_of<'c>(ctx: &'c BuildContext<'_>) -> &'c str {
    ctx.source_path.as_deref().unwrap_or("word/document.xml")
}

/// `hasResolvablePicture`: the paragraph holds a picture whose media resolves
/// (the media is cached for extractRuns).
pub fn has_resolvable_picture(xml: &str, ctx: &BuildContext<'_>) -> Result<bool, Thrown> {
    if !js_regex!(r#"<a:blip[^>]*r:(?:embed|link)\s*=\s*["']|<v:imagedata[^>]*r:id\s*=\s*["']"#)
        .test(xml)
    {
        return Ok(false);
    }
    resolve_blip_media(xml, ctx)?;
    let Some(media_by_rid) = &ctx.media_by_rid else {
        return Ok(false);
    };
    let media_by_rid = media_by_rid.borrow();
    for found in js_regex!(
        r#"<a:blip[^>]*r:(?:embed|link)\s*=\s*["']([^"']+)["']|<v:imagedata[^>]*r:id\s*=\s*["']([^"']+)["']"#
    )
    .find_iter(xml)
    {
        let r_id = found.get(1).or_else(|| found.get(2));
        if let Some(r_id) = r_id
            && !r_id.is_empty()
            && media_by_rid.has(r_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `resolveBlipMedia`: a paragraph's blip and VML imagedata rIds into
/// `ctx.mediaByRid`, so extractRuns can build image runs.
pub fn resolve_blip_media(xml: &str, ctx: &BuildContext<'_>) -> Result<(), Thrown> {
    let Some(media_by_rid) = &ctx.media_by_rid else {
        return Ok(());
    };
    // embed and link matched separately: on a blip carrying both, a combined
    // greedy pattern only captured the link and left the embedded part unresolved
    let refs: Vec<&str> = js_regex!(r#"<a:blip[^>]*r:embed\s*=\s*["']([^"']+)["']"#)
        .find_iter(xml)
        .chain(js_regex!(r#"<a:blip[^>]*r:link\s*=\s*["']([^"']+)["']"#).find_iter(xml))
        .chain(js_regex!(r#"<v:imagedata[^>]*r:id\s*=\s*["']([^"']+)["']"#).find_iter(xml))
        .map(|found| found.get(1).unwrap_or(""))
        .collect();
    for r_id in refs {
        if media_by_rid.borrow().has(r_id) {
            continue;
        }
        let Some(rel) = ctx.rels.get(r_id) else {
            continue;
        };
        if rel.target_mode.as_deref() == Some("External") || is_http_url(&rel.target) {
            media_by_rid
                .borrow_mut()
                .set(r_id, SharedStr::from(rel.target.as_str()));
            continue;
        }
        let data_url = media_data_url(ctx.zip, &ctx.rels, r_id, source_path_of(ctx), ctx.media)?;
        if let Some(data_url) = data_url.filter(|url| !url.is_empty()) {
            media_by_rid.borrow_mut().set(r_id, data_url);
        }
    }
    Ok(())
}

/// `extractImage`: the picture of an a:blip as a data URL, or the target of a
/// linked one.
pub fn extract_image(xml: &str, ctx: &BuildContext<'_>) -> Result<Option<SharedStr>, Thrown> {
    // embedded (r:embed -> word/media/...) or linked (r:link -> external URL)
    let r_id = js_regex!(r#"<a:blip[^>]*r:embed\s*=\s*["']([^"']+)["']"#)
        .exec(xml)
        .and_then(|found| found.get(1))
        .or_else(|| {
            js_regex!(r#"<a:blip[^>]*r:link\s*=\s*["']([^"']+)["']"#)
                .exec(xml)
                .and_then(|found| found.get(1))
        });
    let Some(r_id) = r_id else {
        return Ok(None);
    };
    let Some(rel) = ctx.rels.get(r_id) else {
        return Ok(None);
    };
    // linked pictures (Word downloads them on open; the <img> does the same)
    if rel.target_mode.as_deref() == Some("External") || is_http_url(&rel.target) {
        return Ok(Some(rel.target.as_str().into()));
    }
    match resolve_relationship_target_path(source_path_of(ctx), &rel.target) {
        Some(path) => media_part_data_url(ctx.zip, &path, ctx.media),
        None => Ok(None),
    }
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

/// `relPartPath(ctx, rId)`
pub fn rel_part_path_of(ctx: &BuildContext<'_>, r_id: Option<&str>) -> Option<String> {
    rel_part_path(&ctx.rels, ctx.source_path.as_deref(), r_id)
}

/// The members of `BuildContext` `extractChart` reads and writes.
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
pub fn extract_chart_part(
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
    let Some(part_xml) = canonical_part_text(ctx.zip, &path)? else {
        return Ok(None);
    };
    let part_xml = &*part_xml;
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

/// `extractChart(xml, ctx)`
pub fn extract_chart(xml: &str, ctx: &BuildContext<'_>) -> Result<Option<ChartDisplay>, Thrown> {
    let mut chart_parts = ctx.chart_parts.borrow_mut();
    extract_chart_part(
        xml,
        &mut ChartContext {
            zip: ctx.zip,
            rels: &ctx.rels,
            source_path: ctx.source_path.as_deref(),
            theme_colors: ctx.resolver.theme_colors.as_ref(),
            chart_parts: &mut chart_parts,
        },
    )
}

/// The first capture of a match.
fn capture<'t>(found: Option<jscompat::JsMatch<'t>>) -> Option<&'t str> {
    found.and_then(|found| found.get(1))
}

/// `oleDisplay`: the preview picture (v:imagedata) and ProgID of an OLE
/// embed, and the declared size and alignment of the object. A `Block` with
/// the keys `imageDataUrl`, `oleProgId`, `imageWidthPx`, `imageHeightPx` and
/// `imageAlign` only.
pub fn ole_display(xml: &str, ctx: &BuildContext<'_>) -> Result<Block, Thrown> {
    let mut out = Block::default();
    if let Some(prog_id) = truthy(capture(
        js_regex!(r#"<o:OLEObject[^>]*ProgID="([^"]+)""#).exec(xml),
    )) {
        out.ole_prog_id.set(prog_id.to_owned());
    }
    let path = rel_part_path_of(
        ctx,
        capture(js_regex!(r#"<v:imagedata[^>]*r:id="([^"]+)""#).exec(xml)),
    );
    let file = path.as_deref().and_then(|path| ctx.zip.file(path));
    if let (Some(file), Some(path)) = (file, path.as_deref()) {
        let mime = image_part_mime(ctx.zip, path, ctx.media)?;
        if is_metafile_mime(mime.as_deref()) {
            let bytes = file.bytes().map_err(|error| error.to_string())?;
            if let Some(converted) = ctx
                .media
                .host
                .metafile_to_data_url(bytes, mime.as_deref().unwrap_or(""))
                && !converted.is_empty()
            {
                out.image_data_url.set(converted.into());
            }
        } else if let Some(mime) = mime.as_deref().filter(|mime| !mime.is_empty()) {
            out.image_data_url
                .set(media_part_src(file, path, mime, ctx.media)?.into());
        }
    }
    // Word draws the preview at the declared size: the v:shape style (pt),
    // else the w:object dxaOrig/dyaOrig (twips). Without it the metafile
    // preview's intrinsic pixels (2x dpiScale) blow up to the full content
    // width.
    let style = capture(js_regex!(r#"<v:shape [^>]*style="([^"]*)""#).exec(xml)).unwrap_or("");
    let float = |pattern: &jscompat::JsRegex, text: &str| {
        jscompat::parse_float(capture(pattern.exec(text)).unwrap_or(""))
    };
    let w_pt = float(js_regex!(r"(?:^|;)width:([\d.]+)pt"), style);
    let h_pt = float(js_regex!(r"(?:^|;)height:([\d.]+)pt"), style);
    let obj_attrs = js_regex!(r"<w:object\b[^>]*>")
        .exec(xml)
        .map_or("", |found| found.as_str());
    let int = |pattern: &jscompat::JsRegex| {
        parse_int(capture(pattern.exec(obj_attrs)).unwrap_or(""), Radix::Ten)
    };
    let w_tw = int(js_regex!(r#"w:dxaOrig="(\d+)""#));
    let h_tw = int(js_regex!(r#"w:dyaOrig="(\d+)""#));
    let w = if w_pt > 0.0 {
        (w_pt / 72.0) * 96.0
    } else if w_tw > 0.0 {
        w_tw / 15.0
    } else {
        0.0
    };
    let h = if h_pt > 0.0 {
        (h_pt / 72.0) * 96.0
    } else if h_tw > 0.0 {
        h_tw / 15.0
    } else {
        0.0
    };
    if w > 0.0 {
        out.image_width_px.set(JsNum(math_round(w)));
    }
    if h > 0.0 {
        out.image_height_px.set(JsNum(math_round(h)));
    }
    match capture(js_regex!(r#"<w:jc w:val="([^"]+)""#).exec(xml)) {
        Some("center") => out.image_align.set(BlockImageAlign::Center),
        Some("right" | "end") => out.image_align.set(BlockImageAlign::Right),
        _ => {}
    }
    Ok(out)
}
