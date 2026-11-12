//! Header and footer parts: their layout tables, pictures and paragraphs.

use jscompat::{
    JsNum, Radix, RegexLimit, js_regex, math_round, parse_int, to_number, try_js_regex,
};
use ooxml_xml::{Utf16Map, XNode};

use crate::model::{
    CellBorder, HfImage, HfPartInfo, HfTableFloat, HfTableFloatHorzAnchor, HfTableFloatVertAnchor,
    HfTableFloatXSpec, ParaFormat,
};
use crate::props::collect_nodes;

/// `hfMovablePictureFrag`: a `<w:drawing>` fragment the strip can move and
/// resize, one floating picture with its own extents.
pub fn hf_movable_picture_frag(frag: &str) -> bool {
    js_regex!(r"<wp:anchor[\s>]").test(frag)
        && js_regex!(r"<a:blip[\s>]").test(frag)
        && js_regex!(r"<pic:pic[\s>]").find_iter(frag).count() == 1
        && !js_regex!(r"<(?:wps:|wpg:|w:txbxContent[\s>])").test(frag)
}

/// `anchorDocPrIds`: the `wp:docPr` ids of the anchored drawings below `node`.
pub fn anchor_doc_pr_ids(node: &XNode) -> Vec<String> {
    let mut anchors = Vec::new();
    collect_nodes(node.children(), "wp:anchor", &mut anchors);
    anchors
        .into_iter()
        .filter_map(|anchor| {
            anchor
                .find_child("wp:docPr")
                .and_then(|doc_pr| doc_pr.attr("id"))
        })
        .map(str::to_owned)
        .collect()
}

/// `hasDeepChildOutside`: a descendant named one of `names`, not looking into
/// the subtrees named one of `skip`.
pub fn has_deep_child_outside(node: &XNode, names: &[&str], skip: Option<&[&str]>) -> bool {
    for child in node.children() {
        let name = child.name();
        if let Some(name) = name {
            if names.contains(&name) {
                return true;
            }
            if skip.is_some_and(|skip| skip.contains(&name)) {
                continue;
            }
        }
        if has_deep_child_outside(child, names, skip) {
            return true;
        }
    }
    false
}

/// `hfPartInfo`: what the model keeps of a header or footer part; no
/// `images` key where it has none.
pub fn hf_part_info(part: Option<HfPartInfo>) -> Option<HfPartInfo> {
    let part = part?;
    Some(HfPartInfo {
        text: part.text,
        has_page_number: part.has_page_number,
        paras: part.paras,
        images: part.images.filter(|images| !images.is_empty()),
    })
}

/// `bindHfImageAnchors`: each image whose anchor id (`image_anchor_ids`, the
/// `hfImageAnchorId` of each image) a strip row holds (`row_anchor_ids`, the
/// `hfRowAnchorIds` of each paragraph) is bound to the first such row.
pub fn bind_hf_image_anchors(
    images: &mut [HfImage],
    image_anchor_ids: &[Option<String>],
    row_anchor_ids: &[Option<Vec<String>>],
) {
    for (i, image) in images.iter_mut().enumerate() {
        let Some(id) = image_anchor_ids
            .get(i)
            .and_then(Option::as_deref)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let at = row_anchor_ids.iter().position(|ids| {
            ids.as_ref()
                .is_some_and(|ids| ids.iter().any(|row_id| row_id == id))
        });
        if let Some(at) = at {
            image.anchor_para.set(JsNum(at as f64));
        }
    }
}

/// `stripHfDeletions`: tracked deletions and moves away of drawings leave the
/// part; deleted text stays.
pub fn strip_hf_deletions(xml: &str) -> Result<String, RegexLimit> {
    if !js_regex!(r"<w:(?:del|moveFrom)[\s>]").test(xml) {
        return Ok(xml.to_owned());
    }
    try_js_regex!(
        r"<w:(del|moveFrom)(?=[\s>])(?:[^>/]|\/(?!>))*>[\s\S]*?<\/w:\1>",
        "g"
    )
    .try_replace_all(xml, |block| {
        if js_regex!(r"<w:(?:drawing|pict|object)[\s>]").test(block.as_str()) {
            String::new()
        } else {
            block.as_str().to_owned()
        }
    })
}

/// `hfTblRanges`: the `[start, end)` UTF-16 spans of the top-level `w:tbl`
/// elements of a part.
pub fn hf_tbl_ranges(xml: &str) -> Vec<(u32, u32)> {
    let units = Utf16Map::new(xml);
    hf_tbl_ranges_bytes(xml)
        .into_iter()
        .map(|(start, end)| (units.to_utf16(start), units.to_utf16(end)))
        .collect()
}

/// `hfTblRanges` as byte offsets of `xml`, which is what the readers of a
/// part compare match indexes with.
pub fn hf_tbl_ranges_bytes(xml: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut depth = 0u32;
    let mut start = 0;
    for found in js_regex!(r"<w:tbl[\s>]|<\/w:tbl>").find_iter(xml) {
        if found.as_str() == "</w:tbl>" {
            if depth > 0 {
                depth -= 1;
                if depth == 0 {
                    out.push((start, found.end()));
                }
            }
        } else {
            if depth == 0 {
                start = found.start();
            }
            depth += 1;
        }
    }
    out
}

/// The byte offset of `text.slice(0, end)`: `end` in UTF-16 units, truncated
/// and clamped to the text. An end inside a surrogate pair stops before it.
fn byte_at_unit(text: &str, end: f64) -> usize {
    let end = if end.is_nan() { 0.0 } else { end.trunc() };
    let mut units = 0.0;
    for (byte, c) in text.char_indices() {
        units += c.len_utf16() as f64;
        if units > end {
            return byte;
        }
    }
    text.len()
}

/// `hfCellColumnLeftPx`: px from the margin to the text column of the table
/// cell holding UTF-16 offset `at`: `w:tblInd` plus the grid columns of the
/// cells before it in its row.
pub fn hf_cell_column_left_px(xml: &str, at: f64) -> f64 {
    let units = Utf16Map::new(xml);
    cell_column_left_px(
        xml,
        |start| f64::from(units.to_utf16(start)) < at,
        byte_at_unit(xml, at),
    )
}

/// `hfCellColumnLeftPx` for an `at` that is a byte offset of `xml` (a match
/// index, as the readers of a part count).
pub fn hf_cell_column_left_px_at(xml: &str, at: usize) -> f64 {
    cell_column_left_px(xml, |start| start < at, at.min(xml.len()))
}

/// The body of `hfCellColumnLeftPx`: `before` says whether the byte offset
/// of a tag lies before `at`, `at_byte` is `at` as a byte offset.
fn cell_column_left_px(xml: &str, before: impl Fn(usize) -> bool, at_byte: usize) -> f64 {
    struct Open {
        start: usize,
        first_row: Option<usize>,
        row: Option<usize>,
    }
    // innermost table still open at `at`, with its first row and the row holding `at`
    let mut open: Vec<Open> = Vec::new();
    for found in js_regex!(r"<w:tbl[\s>]|<\/w:tbl>|<w:tr[\s>]")
        .find_iter(xml)
        .take_while(|found| before(found.start()))
    {
        if found.as_str() == "</w:tbl>" {
            open.pop();
        } else if found.as_str().starts_with("<w:tbl") {
            open.push(Open {
                start: found.start(),
                first_row: None,
                row: None,
            });
        } else if let Some(t) = open.last_mut() {
            if t.first_row.is_none() {
                t.first_row = Some(found.start());
            }
            t.row = Some(found.start());
        }
    }
    let Some(Open {
        start: tbl_start,
        first_row: Some(first_row),
        row: Some(row_start),
    }) = open.last()
    else {
        return 0.0;
    };
    let head = &xml[*tbl_start..*first_row];
    let tbl_ind = js_regex!(r#"<w:tblInd\b[^>]*\bw:w\s*=\s*["'](-?\d+)["']"#)
        .exec(head)
        .and_then(|found| found.get(1))
        .map_or(0.0, |raw| parse_int(raw, Radix::Ten));
    // `|| 0`
    let tbl_ind = if tbl_ind == 0.0 || tbl_ind.is_nan() {
        0.0
    } else {
        tbl_ind
    };
    let grid_text = js_regex!(r"<w:tblGrid>([\s\S]*?)<\/w:tblGrid>")
        .exec(head)
        .and_then(|found| found.get(1))
        .unwrap_or("");
    let grid: Vec<f64> = js_regex!(r#"<w:gridCol\b[^>]*\bw:w\s*=\s*["'](\d+)["']"#)
        .find_iter(grid_text)
        .map(|found| parse_int(found.get(1).unwrap_or(""), Radix::Ten))
        .collect();
    let row_end = at_byte.max(*row_start);
    let before = js_regex!(r"<w:tbl[\s>][\s\S]*?<\/w:tbl>", "g")
        .replace_all(&xml[*row_start..row_end], |_| String::new());
    let cells: Vec<&str> = js_regex!(r"<w:tc[\s>]([\s\S]*?)(?=<w:p[\s>]|<w:tc[\s>]|$)")
        .find_iter(&before)
        .map(|found| found.get(1).unwrap_or(""))
        .collect();
    let mut cols = 0.0;
    for cell in cells.iter().take(cells.len().saturating_sub(1)) {
        let span = js_regex!(r#"<w:gridSpan\b[^>]*\bw:val\s*=\s*["'](\d+)["']"#)
            .exec(cell)
            .and_then(|found| found.get(1))
            .map_or(1.0, |raw| parse_int(raw, Radix::Ten));
        // `|| 1`
        cols += if span == 0.0 || span.is_nan() {
            1.0
        } else {
            span
        };
    }
    let taken = if cols < grid.len() as f64 {
        cols as usize
    } else {
        grid.len()
    };
    let twips = tbl_ind + grid[..taken].iter().fold(0.0, |a, b| a + b);
    math_round(twips / 15.0)
}

/// `hfOnlyEmptyRuns`: the paragraph holds nothing but its `w:pPr` and runs
/// with nothing but their `w:rPr`.
pub fn hf_only_empty_runs(p_node: &XNode) -> bool {
    p_node.children().iter().all(|c| match c.name() {
        Some("w:pPr") => true,
        Some("w:r") => c.children().iter().all(|rc| rc.name() == Some("w:rPr")),
        _ => false,
    })
}

/// `hfLine`: a border that draws a line.
pub fn hf_line(b: Option<CellBorder>) -> Option<CellBorder> {
    b.filter(|b| b.style != "none" && b.style != "nil")
}

/// `hfTableFloatOf`: the `w:tblpPr` of a header or footer layout table;
/// `None` where the table is in the flow.
pub fn hf_table_float_of(tbl_pr: Option<&XNode>) -> Option<HfTableFloat> {
    let pos = tbl_pr?.find_child("w:tblpPr")?;
    let number = |key: &str| {
        let v = pos.attr(key).map_or(f64::NAN, to_number);
        v.is_finite().then_some(JsNum(v))
    };
    let x_twips = number("w:tblpX");
    let y_twips = number("w:tblpY");
    let horz_anchor = match pos.attr("w:horzAnchor") {
        Some("page") => Some(HfTableFloatHorzAnchor::Page),
        Some("margin") => Some(HfTableFloatHorzAnchor::Margin),
        Some("text") => Some(HfTableFloatHorzAnchor::Text),
        _ => None,
    };
    let vert_anchor = match pos.attr("w:vertAnchor") {
        Some("page") => Some(HfTableFloatVertAnchor::Page),
        Some("margin") => Some(HfTableFloatVertAnchor::Margin),
        Some("text") => Some(HfTableFloatVertAnchor::Text),
        _ => None,
    };
    let x_spec = match pos.attr("w:tblpXSpec") {
        Some("left") => Some(HfTableFloatXSpec::Left),
        Some("center") => Some(HfTableFloatXSpec::Center),
        Some("right") => Some(HfTableFloatXSpec::Right),
        Some("inside") => Some(HfTableFloatXSpec::Inside),
        Some("outside") => Some(HfTableFloatXSpec::Outside),
        _ => None,
    };
    Some(HfTableFloat {
        x_twips,
        y_twips,
        horz_anchor,
        vert_anchor,
        x_spec,
    })
}

/// `withoutResolvedGeometry`: the direct paragraph format without the keys the
/// resolver settles through the style chain.
pub fn without_resolved_geometry(direct: Option<ParaFormat>) -> ParaFormat {
    let Some(mut rest) = direct else {
        return ParaFormat::default();
    };
    rest.align.delete();
    rest.bidi.delete();
    rest.indent_left.delete();
    rest.indent_right.delete();
    rest.indent_first_line.delete();
    rest.space_before.delete();
    rest.space_after.delete();
    rest.line_rule.delete();
    rest.line_raw_twips.delete();
    rest.line_spacing.delete();
    rest.borders.delete();
    rest.border_lines.delete();
    rest.border_pad.delete();
    rest.border_reset.delete();
    rest
}
