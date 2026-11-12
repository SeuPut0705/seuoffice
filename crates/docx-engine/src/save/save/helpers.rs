//! The small functions of patch.ts that `saveDocx` and the part writers share.

use std::collections::HashSet;

use jscompat::{JsNum, Radix, TryJsRegex, js_regex, number_to_string, parse_int, try_js_regex};
use ooxml_pkg::Package;

use super::js::{dynamic, limit, replace_first, replace_first_with};
use super::types::SaveBlock;
use super::xml_number_usable::{usable_number, usable_picture_size};
use crate::blank::{CustomNumberingLevel, custom_level_xml, merge_level_xml};
use crate::model::{MapEntries, NewImage, NewImageParaSpacing, StyleInfo, StyleInfoType};
use crate::revision_xml::clean_move_range_markers;

/// `DOCPR_ID_BASE`: wp:docPr/@id of a newly embedded picture is this plus its sequence.
pub const DOCPR_ID_BASE: f64 = 9000.0;

/// `EMU_PER_TWIP`
const EMU_PER_TWIP: f64 = 635.0;

/// `usableNewImage`: a new picture with each number that is no usable
/// drawing value treated as absent.
pub fn usable_new_image(image: &NewImage) -> NewImage {
    let (width, height) = usable_picture_size(image.width_px.0, image.height_px.0);
    let mut out = image.clone();
    out.width_px = JsNum(width);
    out.height_px = JsNum(height);
    if out
        .rot_deg
        .is_some_and(|n| usable_number(n.0, 1.0).is_none())
    {
        out.rot_deg = None;
    }
    if out
        .z_order
        .is_some_and(|n| usable_number(n.0, 1.0).is_none())
    {
        out.z_order = None;
    }
    if out.pos_offset_emu.as_ref().is_some_and(|off| {
        usable_number(off.x.0, 1.0).is_none() || usable_number(off.y.0, 1.0).is_none()
    }) {
        out.pos_offset_emu = None;
    }
    if let Some(spacing) = out.para_spacing.as_mut() {
        let drop = |value: &mut Option<JsNum>| {
            if value.is_some_and(|n| usable_number(n.0, EMU_PER_TWIP).is_none()) {
                *value = None;
            }
        };
        let NewImageParaSpacing {
            before_twips,
            after_twips,
            line_twips,
            ..
        } = spacing;
        drop(before_twips);
        drop(after_twips);
        drop(line_twips);
    }
    out
}

/// `relTagWithId`: the `<Relationship>` tag carrying a given Id, either
/// quote style and with any spacing around `=`. The id goes into the
/// pattern as it is.
pub fn rel_tag_with_id(id: &str) -> Result<TryJsRegex, String> {
    dynamic(
        &format!(r#"<Relationship\s[^>]*\bId\s*=\s*(["']){id}\1[^>]*/>"#),
        "",
    )
}

/// `occupiedRelIds`: every relationship id a .rels part already hands out,
/// in one pass over the part.
pub fn occupied_rel_ids(rels_xml: &str) -> Result<HashSet<String>, String> {
    let marker = js_regex!(r"<Relationship\s");
    let tag_id = try_js_regex!(r#"\bId\s*=\s*(["'])(rId\d+)\1"#, "g");
    let mut taken = HashSet::new();
    let mut pos = 0;
    while pos < rels_xml.len() {
        let Some(gt) = rels_xml[pos..].find('>').map(|at| at + pos) else {
            break;
        };
        // one candidate tag is one `>`-delimited run, and it only counts when it self-closes
        if gt > 0 && rels_xml.as_bytes()[gt - 1] == b'/' {
            let chunk = &rels_xml[pos..gt];
            if let Some(found) = marker.exec(chunk) {
                for id in tag_id.try_find_from(chunk, found.start()) {
                    let id = id.map_err(limit)?;
                    taken.insert(id.get(2).unwrap_or_default().to_owned());
                }
            }
        }
        pos = gt + 1;
    }
    Ok(taken)
}

/// `nextFreeRelId`: the lowest id from rId1 the part does not already hand out.
pub fn next_free_rel_id(rels_xml: &str) -> Result<String, String> {
    let taken = occupied_rel_ids(rels_xml)?;
    let mut n = 1u64;
    while taken.contains(&format!("rId{n}")) {
        n += 1;
    }
    Ok(format!("rId{n}"))
}

/// `replaceAbstractNumLevel`: swap one w:lvl inside the named abstractNum; a
/// missing level is appended in ilvl order.
pub fn replace_abstract_num_level(
    xml: &str,
    abstract_num_id: &str,
    ilvl: f64,
    level: &CustomNumberingLevel,
) -> Result<String, String> {
    let id = jscompat::regex_escape(abstract_num_id);
    let abs_re = dynamic(
        &format!(r#"<w:abstractNum [^>]*w:abstractNumId="{id}"[^>]*>[\s\S]*?</w:abstractNum>"#),
        "",
    )?;
    let Some(abs) = abs_re.try_exec(xml).map_err(limit)? else {
        return Ok(xml.to_owned());
    };
    let abs_text = abs.as_str().to_owned();
    let ilvl_text = number_to_string(ilvl);
    let lvl_re = dynamic(
        &format!(
            r#"<w:lvl [^>]*w:ilvl="{ilvl_text}"[^>]*>[\s\S]*?</w:lvl>|<w:lvl [^>]*w:ilvl="{ilvl_text}"[^>]*/>"#
        ),
        "",
    )?;
    let mut body = abs_text.clone();
    let existing = lvl_re
        .try_exec(&body)
        .map_err(limit)?
        .map(|found| found.as_str().to_owned());
    if let Some(existing) = existing {
        let merged = merge_level_xml(&existing, level, ilvl);
        body = jscompat::replace_first_string(&body, &existing, &merged);
    } else {
        let lvl_xml = custom_level_xml(level, ilvl);
        let later = try_js_regex!(r#"<w:lvl [^>]*w:ilvl="(\d)""#, "g");
        let mut insert_at = body.rfind("</w:abstractNum>");
        for found in later.try_find_iter(&body) {
            let found = found.map_err(limit)?;
            if parse_int(found.get(1).unwrap_or_default(), Radix::Ten) > ilvl {
                insert_at = Some(found.start());
                break;
            }
        }
        // lastIndexOf = -1 would slice from the end: the part always has the close tag
        let at = insert_at.unwrap_or(0);
        body = format!("{}{lvl_xml}{}", &body[..at], &body[at..]);
    }
    Ok(jscompat::replace_first_string(xml, &abs_text, &body))
}

/// `patchCoreProps`: only a real save updates dcterms:modified and
/// cp:revision; `None` = no change. `now_ms` stands for `new Date()`.
pub fn patch_core_props(
    xml: &str,
    saved_at: Option<&str>,
    now_ms: f64,
) -> Result<Option<String>, String> {
    let iso = saved_at.map_or_else(|| to_iso_string(now_ms), str::to_owned);
    let iso = replace_first(try_js_regex!(r"\.\d{3}Z$"), 0, &iso, "Z")?;
    let mut out = replace_first(
        try_js_regex!(r"(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)"),
        2,
        xml,
        &format!("$1{iso}$2"),
    )?;
    out = replace_first_with(
        try_js_regex!(r"(<cp:revision>)(\d+)(<\/cp:revision>)"),
        &out,
        |found| {
            let open = found.get(1).unwrap_or_default();
            let digits = found.get(2).unwrap_or_default();
            let close = found.get(3).unwrap_or_default();
            let next = parse_int(digits, Radix::Ten) + 1.0;
            if next.is_finite() {
                format!("{open}{}{close}", number_to_string(next))
            } else {
                format!("{open}{digits}{close}")
            }
        },
    )?;
    Ok((out != xml).then_some(out))
}

/// `new Date(ms).toISOString()`
pub fn to_iso_string(ms: f64) -> String {
    let (year, month, day) = jscompat::utc_date_parts(ms).unwrap_or((1970.0, 0.0, 1.0));
    let in_day = ms.trunc().rem_euclid(86_400_000.0) as u64;
    let (hours, minutes, seconds, millis) = (
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000,
    );
    let year_text = if (0.0..=9999.0).contains(&year) {
        format!("{:04}", year as i64)
    } else {
        format!(
            "{}{:06}",
            if year < 0.0 { '-' } else { '+' },
            year.abs() as i64
        )
    };
    format!(
        "{year_text}-{:02}-{:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z",
        month as u64 + 1,
        day as u64
    )
}

/// `defaultParagraphStyleId`: the paragraph style unstyled paragraphs resolve to.
pub fn default_paragraph_style_id(styles: &MapEntries<String, StyleInfo>) -> Option<&str> {
    styles
        .0
        .iter()
        .find(|(_, info)| info.r#type == StyleInfoType::Paragraph && info.is_default == Some(true))
        .map(|(_, info)| info.style_id.as_str())
}

/// `missingHeadingLevels`: the heading levels the generated body uses that
/// the document has no heading style for.
pub fn missing_heading_levels(
    blocks: &[SaveBlock],
    heading_style_ids: &MapEntries<JsNum, String>,
) -> Vec<f64> {
    let mut missing: Vec<f64> = Vec::new();
    for block in blocks {
        let super::types::SaveBlockKind::Generated { block, .. } = &block.kind else {
            continue;
        };
        if block.r#type.as_str() != "heading"
            || block.outline_only == Some(true)
            || block.style_id.as_deref().is_some_and(|id| !id.is_empty())
        {
            continue;
        }
        let level = jscompat::math_min(
            jscompat::math_max(block.level.map_or(1.0, |n| n.0), 1.0),
            9.0,
        );
        let same = |a: f64, b: f64| a == b || (a.is_nan() && b.is_nan());
        if !heading_style_ids
            .0
            .iter()
            .any(|(key, _)| same(key.0, level))
            && !missing.iter().any(|have| same(*have, level))
        {
            missing.push(level);
        }
    }
    missing.sort_by(|a, b| {
        (a - b)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    missing
}

/// `insertBeforeClosingTag`
pub fn insert_before_closing_tag(xml: &str, content: &str) -> String {
    match xml.rfind("</") {
        None => format!("{xml}{content}"),
        Some(close) => format!("{}{content}{}", &xml[..close], &xml[close..]),
    }
}

/// `markParagraphRevision`: mark the paragraph mark of a whole inserted or
/// deleted paragraph with the record in `w:pPr/w:rPr`.
pub fn mark_paragraph_revision(
    paragraph_xml: &str,
    kind: &str,
    attrs: &str,
) -> Result<String, String> {
    let record = format!("<w:{kind}{attrs}/>");
    let self_closed = paragraph_xml.starts_with("<w:p/>");
    let (open, rest) = if self_closed {
        ("<w:p>", &paragraph_xml["<w:p/>".len()..])
    } else {
        let end = paragraph_xml.find('>').map_or(0, |at| at + 1);
        (&paragraph_xml[..end], &paragraph_xml[end..])
    };
    let p_pr_at = js_regex!(r"<w:pPr(?:\s|>)")
        .exec(rest)
        .map(|found| found.start());
    if p_pr_at.is_some() {
        // already marked: a redline saved again must not grow a second record
        let marked = dynamic(
            &format!(r"<w:rPr[\s>]((?:(?!</w:rPr>)[\s\S])*)<w:{kind}[\s/]"),
            "",
        )?
        .try_test(rest)
        .map_err(limit)?;
        if marked {
            return Ok(paragraph_xml.to_owned());
        }
    }
    let Some(p_pr_at) = p_pr_at else {
        return Ok(format!(
            "{open}<w:pPr><w:rPr>{record}</w:rPr></w:pPr>{rest}"
        ));
    };
    let r_pr_at = rest[p_pr_at..].find("<w:rPr").map(|at| at + p_pr_at);
    let p_pr_close_at = rest[p_pr_at..].find("</w:pPr>").map(|at| at + p_pr_at);
    if let Some(r_pr_at) = r_pr_at
        && p_pr_close_at.is_none_or(|close| r_pr_at < close)
    {
        // CT_ParaRPr order: w:ins/w:del come first
        let open_end = rest[r_pr_at..].find('>').map_or(0, |at| at + r_pr_at + 1);
        return Ok(format!(
            "{}{record}{}",
            &rest[..open_end],
            &rest[open_end..]
        ));
    }
    // no rPr yet: before a pPrChange if one is there (CT_PPr order), else before the pPr closes
    let change_at = rest[p_pr_at..].find("<w:pPrChange").map(|at| at + p_pr_at);
    let at = match change_at {
        Some(change) if p_pr_close_at.is_none_or(|close| change < close) => Some(change),
        _ => p_pr_close_at,
    };
    let Some(at) = at else {
        return Ok(format!(
            "{open}<w:pPr><w:rPr>{record}</w:rPr></w:pPr>{rest}"
        ));
    };
    Ok(format!(
        "{open}{}<w:rPr>{record}</w:rPr>{}",
        &rest[..at],
        &rest[at..]
    ))
}

/// `nextRevisionIdAllocator`: revision w:id values for one save, seeded above
/// every id in every story part.
pub struct RevisionIds {
    next: f64,
}

impl RevisionIds {
    pub fn new(parts_xml: &[String], floor: f64) -> Result<Self, String> {
        let mut next = jscompat::math_max(9001.0, floor);
        let re = try_js_regex!(r#"\bw:id\s*=\s*["'](\d+)["']"#, "g");
        for xml in parts_xml {
            for found in re.try_find_iter(xml) {
                let found = found.map_err(limit)?;
                next = jscompat::math_max(
                    next,
                    parse_int(found.get(1).unwrap_or_default(), Radix::Ten) + 1.0,
                );
            }
        }
        Ok(Self { next })
    }

    pub fn allocate(&mut self) -> String {
        let id = number_to_string(self.next);
        self.next += 1.0;
        id
    }
}

/// `storyPartsXml`: the header, footer, notes and comments parts, in package order.
pub fn story_parts_xml(zip: &Package) -> Result<Vec<String>, String> {
    let re = js_regex!(r"^word\/(?:header|footer|footnotes|endnotes|comments)\d*\.xml$");
    let mut out = Vec::new();
    for part in zip.parts() {
        if part.is_dir || !re.test(&part.name) {
            continue;
        }
        out.push(part.text().map_err(|e| e.to_string())?.to_owned());
    }
    Ok(out)
}

/// `fillRevisionIds`: editor-recorded row/cell revisions leave w:id empty;
/// the save mints one here.
pub fn fill_revision_ids(
    xml: &str,
    allocate: &mut dyn FnMut() -> String,
) -> Result<String, String> {
    try_js_regex!(r#"(<w:(?:ins|del|cellIns|cellDel)\b[^>]*?\sw:id=)"""#, "g")
        .try_replace_all(xml, |found| {
            format!("{}\"{}\"", found.get(1).unwrap_or_default(), allocate())
        })
        .map_err(limit)
}

/// `maxBookmarkId`: highest w:bookmarkStart/@w:id in the document, 0 when it holds no bookmark.
pub fn max_bookmark_id(document_xml: &str) -> Result<f64, String> {
    let mut max = 0.0;
    for found in try_js_regex!(
        r#"<w:bookmark(?:Start|End)\s[^>]*?\bid\s*=\s*(["'])(\d+)\1"#,
        "g"
    )
    .try_find_iter(document_xml)
    {
        let found = found.map_err(limit)?;
        max = jscompat::math_max(max, parse_int(found.get(2).unwrap_or_default(), Radix::Ten));
    }
    Ok(max)
}

/// `nextBookmarkIdAllocator`: w:bookmarkStart/@w:id values seeded above every id the part holds.
pub struct BookmarkIds {
    next: f64,
}

impl BookmarkIds {
    pub fn new(document_xml: &str) -> Result<Self, String> {
        Ok(Self {
            next: max_bookmark_id(document_xml)? + 1.0,
        })
    }

    pub fn allocate(&mut self) -> f64 {
        let id = self.next;
        self.next += 1.0;
        id
    }
}

/// `maxRelId`: highest rIdN in a .rels part, or 1000 when the part is absent.
pub fn max_rel_id(rels_xml: Option<&str>) -> Result<f64, String> {
    let Some(rels_xml) = rels_xml.filter(|xml| !xml.is_empty()) else {
        return Ok(1000.0);
    };
    let mut max = 0.0;
    for found in try_js_regex!(r#"\bId\s*=\s*(["'])rId(\d+)\1"#, "g").try_find_iter(rels_xml) {
        let found = found.map_err(limit)?;
        let n = parse_int(found.get(2).unwrap_or_default(), Radix::Ten);
        if n > max {
            max = n;
        }
    }
    Ok(max)
}

/// `nextImageSeq`: one above the highest `word/media/aidocsN.` in the package.
pub fn next_image_seq(zip: &Package) -> f64 {
    let re = js_regex!(r"^word\/media\/aidocs(\d+)\.");
    let mut max = 0.0;
    for part in zip.parts() {
        if let Some(found) = re.exec(&part.name) {
            max = jscompat::math_max(max, parse_int(found.get(1).unwrap_or_default(), Radix::Ten));
        }
    }
    max + 1.0
}

/// `maxDocPrId`: highest wp:docPr/@id in the document, 0 when it holds no drawing.
pub fn max_doc_pr_id(document_xml: &str) -> Result<f64, String> {
    let mut max = 0.0;
    for found in try_js_regex!(r#"<wp:docPr\s[^>]*?\bid\s*=\s*(["'])(\d+)\1"#, "g")
        .try_find_iter(document_xml)
    {
        let found = found.map_err(limit)?;
        max = jscompat::math_max(max, parse_int(found.get(2).unwrap_or_default(), Radix::Ten));
    }
    Ok(max)
}

/// `nextDocPrSeq`: the seed of the docPr sequence counter.
pub fn next_doc_pr_seq(zip: &Package, document_xml: &str) -> Result<f64, String> {
    Ok(jscompat::math_max(
        next_image_seq(zip),
        max_doc_pr_id(document_xml)? - DOCPR_ID_BASE,
    ))
}

/// `retargetImageBlip`: re-point a drawing paragraph's first `<a:blip>` at a
/// new image relationship and drop a stale crop.
pub fn retarget_image_blip(xml: &str, r_id: &str) -> Result<String, String> {
    let Some(blip) = try_js_regex!(r"<a:blip\b[^>]*\/?>")
        .try_exec(xml)
        .map_err(limit)?
    else {
        return Ok(xml.to_owned());
    };
    let mut tag = blip.as_str().to_owned();
    // a surviving r:link would let Word refresh from the old external file
    if tag.contains("r:embed=\"") {
        tag = replace_first(
            try_js_regex!(r#"r:embed="[^"]*""#),
            0,
            &tag,
            &format!("r:embed=\"{r_id}\""),
        )?;
        tag = replace_first(try_js_regex!(r#"\s+r:link="[^"]*""#), 0, &tag, "")?;
    } else if tag.contains("r:link=\"") {
        tag = replace_first(
            try_js_regex!(r#"r:link="[^"]*""#),
            0,
            &tag,
            &format!("r:embed=\"{r_id}\""),
        )?;
    } else {
        tag = replace_first(
            try_js_regex!(r"<a:blip\b"),
            0,
            &tag,
            &format!("<a:blip r:embed=\"{r_id}\""),
        )?;
    }
    let mut out = format!("{}{tag}{}", &xml[..blip.start()], &xml[blip.end()..]);
    out = replace_first(try_js_regex!(r"<a:srcRect\b[^>]*\/>"), 0, &out, "")?;
    out = replace_first(
        try_js_regex!(r"<a:fillRect\b[^>]+\/>"),
        0,
        &out,
        "<a:fillRect/>",
    )?;
    out = replace_first(
        try_js_regex!(r"<a:ext\b[^>]*>\s*<\w+:svgBlip\b[\s\S]*?<\/a:ext>"),
        0,
        &out,
        "",
    )?;
    replace_first(try_js_regex!(r"<a:extLst>\s*<\/a:extLst>"), 0, &out, "")
}

/// `carriesMoveRanges`
pub fn carries_move_ranges(name: &str, document_path: &str) -> bool {
    js_regex!(r"\.xml$", "i").test(name)
        && (name == document_path
            || js_regex!(r"^word\/(?:header|footer)[^/]*\.xml$", "i").test(name)
            || js_regex!(r"^word\/(?:footnotes|endnotes)\.xml$", "i").test(name)
            || name == "word/glossary/document.xml")
}

/// `cleanStoryMoveRanges`: drop the move-range markers whose counterpart is gone.
pub fn clean_story_move_ranges(zip: &mut Package, document_path: &str) -> Result<(), String> {
    let mut updates: Vec<(String, String)> = Vec::new();
    for part in zip.parts() {
        if part.is_dir || !carries_move_ranges(&part.name, document_path) {
            continue;
        }
        let xml = part.text().map_err(|e| e.to_string())?;
        let cleaned = clean_move_range_markers(xml);
        if cleaned.removed > 0 {
            updates.push((part.name.clone(), cleaned.xml.into_owned()));
        }
    }
    for (name, xml) in updates {
        zip.set_file(name, xml.into_bytes());
    }
    Ok(())
}

/// `hasOrphanMoveRanges`: whether `clean_story_move_ranges` would change a part.
pub fn has_orphan_move_ranges(zip: &Package, document_path: &str) -> Result<bool, String> {
    for part in zip.parts() {
        if part.is_dir || !carries_move_ranges(&part.name, document_path) {
            continue;
        }
        let xml = part.text().map_err(|e| e.to_string())?;
        if clean_move_range_markers(xml).removed > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `findChartWorkbookPath`: the zip-relative path of the embedded workbook of
/// a chart part, read off the chart's rels file; `None` when there is none.
pub fn find_chart_workbook_path(docx_bytes: &[u8], chart_path: &str) -> Option<String> {
    let zip = ooxml_pkg::load_docx_package(docx_bytes).ok()?;
    // chart path: word/charts/chart1.xml -> rels: word/charts/_rels/chart1.xml.rels
    let slash = chart_path.rfind('/')?;
    let (dir, file) = (&chart_path[..slash], &chart_path[slash + 1..]);
    let rels_path = format!("{dir}/_rels/{file}.rels");
    let rels_xml = zip.text(&rels_path).ok()??;
    for tag in js_regex!(r"<Relationship\b[^>]*\/>", "g").find_iter(rels_xml) {
        let ty = js_regex!(r#"\bType\s*=\s*(["'])([^"']*)\1"#)
            .exec(tag.as_str())
            .and_then(|found| found.get(2).map(str::to_owned));
        if !ty.is_some_and(|ty| ty.ends_with("/package")) {
            continue;
        }
        let target = js_regex!(r#"\bTarget\s*=\s*(["'])([^"']*)\1"#)
            .exec(tag.as_str())
            .and_then(|found| found.get(2).filter(|t| !t.is_empty()).map(str::to_owned));
        if let Some(target) = target {
            return crate::package::resolve_relationship_target_path(chart_path, &target);
        }
    }
    None
}

/// `readDocxPartBase64`: the raw base64 bytes of a part of a docx; `None` if
/// the part does not exist or the file cannot be read.
pub fn read_docx_part_base64(docx_bytes: &[u8], path: &str) -> Option<String> {
    let zip = ooxml_pkg::load_docx_package(docx_bytes).ok()?;
    let bytes = zip.bytes(path).ok()??;
    Some(jscompat::base64(bytes))
}
