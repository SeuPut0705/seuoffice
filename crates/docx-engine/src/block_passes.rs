//! The passes over the parsed blocks (packages/docx-engine/src/parse-block-passes.ts):
//! protected leading breaks, balanced DBCS spacing, image z-order
//! normalization, the column span of a floating table and the band of
//! side-wrapped boxes before a table.

use jscompat::{JsNum, JsRegex, RegexLimit, js_regex, math_round, trim, truthy, try_js_regex};
use serde::Serialize;

use crate::char_class::{CharClass, char_class, is_double_byte_char};
use crate::model::{
    Block, BlockType, FieldDisplay, FieldDisplayKind, Run, SectionSettings, TableModel,
    TableModelFloatPosHorzAnchor, TextboxDisplay,
};
use crate::props::strip_textboxes;
use crate::xml_tag::remove_elements;
use crate::xml_text::EMU_PER_PX;

/// `PAGE_BR_RE`
fn page_br_re() -> &'static JsRegex {
    js_regex!(r#"<w:br\s[^>]*w:type=(["'])page\1"#)
}

/// `hostParagraphBreaksBefore`. A paragraph whose pPr runs past about a
/// million characters passes the bound of one search.
fn host_paragraph_breaks_before(xml: &str) -> Result<bool, RegexLimit> {
    // w:pPrChange holds the tracked-change *previous* pPr, not the live setting
    let live = remove_elements(xml, "w:pPrChange", None);
    let head = try_js_regex!(r"^<w:p(?:\s[^>]*)?>\s*<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*)<\/w:pPr>")
        .try_exec(&live)?;
    let p_pr = head.as_ref().and_then(|found| found.get(1));
    Ok(p_pr.is_some_and(|p_pr| {
        js_regex!(r#"<w:pageBreakBefore(?:\s+w:val="(?:1|true|on)")?\s*\/>"#).test(p_pr)
    }))
}

/// The text of the `w:t` elements of `xml`, joined: the visible text ahead of a break.
fn wt_text_of(xml: &str) -> String {
    js_regex!(r"<w:t[^>]*>([^<]*)<\/w:t>", "g")
        .find_iter(xml)
        .map(|found| found.get(1).unwrap_or(""))
        .collect()
}

/// `leadsWithPageBreak`: a page break with no visible text ahead of it, text
/// boxes left out.
fn leads_with_page_break(xml: &str) -> bool {
    let body = strip_textboxes(xml);
    match page_br_re().exec(&body).map(|found| found.start()) {
        Some(br) => trim(&wt_text_of(&body[..br])).is_empty(),
        None => false,
    }
}

/// What `applyProtectedLeadingBreaks` writes into one block.
enum LeadingBreak {
    /// `b.format = { ...b.format, pageBreakBefore: true }`
    PageBreakBefore,
    /// `b.fieldDisplay = { kind: 'pageBreak' }`
    FieldPageBreak,
}

/// The tests of one block of `applyProtectedLeadingBreaks`, in its order.
fn leading_break(b: &Block) -> Result<Option<LeadingBreak>, RegexLimit> {
    if !matches!(*b.r#type, Some(BlockType::Image | BlockType::Passthrough))
        || b.format
            .as_ref()
            .is_some_and(|format| *format.page_break_before == Some(true))
    {
        return Ok(None);
    }
    let Some(xml) = truthy(b.original_xml.as_ref().and_then(Option::as_deref)) else {
        return Ok(None);
    };
    if *b.hidden == Some(true) || b.label.as_deref() == Some("Section break paragraph") {
        return Ok(None);
    }
    // the anchor paragraph's own pPr is dropped with its runs
    if host_paragraph_breaks_before(xml)? {
        return Ok(Some(LeadingBreak::PageBreakBefore));
    }
    // a field paragraph (a heading that closes the TOC's fldChar) renders its
    // result text only: a page break ahead of every visible run turns the page
    if *b.r#type == Some(BlockType::Passthrough) {
        let text_field = b.field_display.as_ref().is_some_and(|display| {
            display.kind == FieldDisplayKind::Text && display.empty_line != Some(true)
        });
        return Ok(
            (text_field && leads_with_page_break(xml)).then_some(LeadingBreak::PageBreakBefore)
        );
    }
    let drawing = js_regex!(r"<w:drawing[\s>]|<w:pict[\s>]|<w:object[\s>]")
        .exec(xml)
        .map(|found| found.start());
    let head = &xml[..drawing.unwrap_or(xml.len())];
    if let Some(br) = page_br_re().exec(head).map(|found| found.start()) {
        let text_before = wt_text_of(&head[..br]);
        return Ok(trim(&text_before)
            .is_empty()
            .then_some(LeadingBreak::PageBreakBefore));
    }
    // a page-break run after the drawing turns the page below the picture
    if let Some(drawing) = drawing
        && b.field_display.is_none()
        && page_br_re().test(&strip_textboxes(&xml[drawing..]))
    {
        return Ok(Some(LeadingBreak::FieldPageBreak));
    }
    Ok(None)
}

/// `applyProtectedLeadingBreaks`: a protected image block swallows the
/// paragraph's runs and pPr, so a page break before the drawing becomes the
/// block's pageBreakBefore, and one after it a pageBreak field display.
pub fn apply_protected_leading_breaks(blocks: &mut [Block]) -> Result<(), RegexLimit> {
    for b in blocks.iter_mut() {
        match leading_break(b)? {
            Some(LeadingBreak::PageBreakBefore) => {
                let mut format = b.format.as_ref().cloned().unwrap_or_default();
                format.page_break_before.set(true);
                b.format.set(format);
            }
            Some(LeadingBreak::FieldPageBreak) => b.field_display.set(FieldDisplay {
                kind: FieldDisplayKind::PageBreak,
                left: None,
                right: None,
                level: None,
                anchor: None,
                deleted: None,
                mark_deleted: None,
                num: None,
                sz_half_points: None,
                font_family: None,
                ea_font_family: None,
                bold: None,
                run_style_id: None,
                num_tab_twips: None,
                hang_twips: None,
                leader: None,
                right_tab_twips: None,
                runs: None,
                empty_line: None,
                align: None,
                line_rule: None,
                line_raw_twips: None,
                line_spacing: None,
                space_before_twips: None,
                space_after_twips: None,
                space_before_auto: None,
                space_after_auto: None,
                indent_left_twips: None,
                indent_right_twips: None,
                indent_first_line_twips: None,
                additive_spacing: None,
            }),
            None => {}
        }
    }
    Ok(())
}

/// `SINGLE_SPACING_HANGUL_KANA_FONTS`: Word probe (2026-09-03), Han and
/// fullwidth forms always take the doubled spacing, hangul/kana only in legacy
/// faces, not in these.
const SINGLE_SPACING_HANGUL_KANA_FONTS: [&str; 8] = [
    "malgungothic",
    "malgungothicsemilight",
    "\u{b9d1}\u{c740}\u{ace0}\u{b515}",
    "nanumgothic",
    "\u{b098}\u{b214}\u{ace0}\u{b515}",
    "applesdgothicneo",
    "mspgothic",
    "\u{ff4d}\u{ff53}\u{ff50}\u{30b4}\u{30b7}\u{30c3}\u{30af}",
];

/// `keepsHangulKanaSingle`
pub fn keeps_hangul_kana_single(font: Option<&str>) -> bool {
    truthy(font).is_some_and(|font| {
        let key =
            js_regex!(r"[\s\u3000]+", "g").replace_all(&font.to_lowercase(), |_| String::new());
        SINGLE_SPACING_HANGUL_KANA_FONTS.contains(&&*key)
    })
}

/// `isHangulOrKana`
fn is_hangul_or_kana(cp: u32) -> bool {
    matches!(char_class(cp), CharClass::Hangul | CharClass::Kana)
}

/// `doubledGlyphFraction`: the share of the code points of `text` that take
/// the doubled spacing.
fn doubled_glyph_fraction(text: &str, hangul_kana_single: bool) -> f64 {
    let mut wide = 0.0;
    let mut n = 0.0;
    for ch in text.chars() {
        let cp = u32::from(ch);
        if is_double_byte_char(cp) && !(hangul_kana_single && is_hangul_or_kana(cp)) {
            wide += 1.0;
        }
        n += 1.0;
    }
    if n > 0.0 { wide / n } else { 0.0 }
}

/// `applyBalancedDbcsSpacing`: settings.xml balanceSingleByteDoubleByteWidth
/// makes rPr w:spacing count double on double-byte characters; the
/// display-only charSpacingTwips is scaled by each run's doubled-glyph mix.
pub fn apply_balanced_dbcs_spacing<'a>(
    run_groups: impl IntoIterator<Item = Option<&'a mut Vec<Run>>>,
    default_font: Option<&str>,
) {
    for runs in run_groups {
        let Some(runs) = runs else {
            continue;
        };
        for r in runs.iter_mut() {
            let Some(char_spacing) = r
                .char_spacing_twips
                .map(|twips| twips.0)
                .filter(|twips| *twips != 0.0 && !twips.is_nan())
            else {
                continue;
            };
            let Some(text) = truthy(r.text.as_deref()) else {
                continue;
            };
            // the gate is the face Word draws the hangul with: a paragraph style's
            // East Asian slot counts as much as a direct w:rFonts
            let frac = doubled_glyph_fraction(
                text,
                keeps_hangul_kana_single(
                    r.east_asia_font
                        .as_deref()
                        .or_else(|| {
                            r.effective
                                .as_ref()
                                .and_then(|effective| effective.fonts.east_asia.as_deref())
                        })
                        .or(default_font),
                ),
            );
            if frac > 0.0 {
                r.char_spacing_twips
                    .set(JsNum(math_round(char_spacing * (1.0 + frac) * 10.0) / 10.0));
            }
        }
    }
}

/// `fromBoxes` of `blockRunGroups`
fn run_groups_from_boxes<'a>(
    groups: &mut Vec<Option<&'a mut Vec<Run>>>,
    boxes: Option<&'a mut Vec<TextboxDisplay>>,
) {
    for textbox in boxes.into_iter().flatten() {
        for para in textbox.paras.as_mut().into_iter().flatten() {
            groups.push(para.runs.as_mut());
        }
    }
}

/// `fromTable` of `blockRunGroups`
fn run_groups_from_table<'a>(
    groups: &mut Vec<Option<&'a mut Vec<Run>>>,
    table: Option<&'a mut TableModel>,
) {
    let Some(table) = table else {
        return;
    };
    for row in table.rows.iter_mut() {
        for cell in row.iter_mut() {
            for para in cell.rich_paras.as_mut().into_iter().flatten() {
                groups.push(Some(&mut para.runs));
            }
            run_groups_from_boxes(groups, cell.anchored_boxes.as_mut());
            for nested in cell.nested_tables.as_mut().into_iter().flatten() {
                run_groups_from_table(groups, Some(nested));
            }
        }
    }
}

/// `blockRunGroups`: every run container reachable from the parsed blocks
/// (tables, textboxes, nested tables), `None` where a block has no such
/// container. The containers are borrowed for a later pass to mutate, as the
/// TypeScript hands out the arrays themselves.
pub fn block_run_groups(blocks: &mut [Block]) -> Vec<Option<&mut Vec<Run>>> {
    let mut groups = Vec::new();
    for b in blocks.iter_mut() {
        groups.push(b.runs.as_mut());
        groups.push(b.stray_runs.as_mut());
        run_groups_from_table(&mut groups, b.table.as_mut());
        run_groups_from_boxes(&mut groups, b.textboxes.as_mut());
    }
    groups
}

/// One entry of `anchored` in `normalizeImageZOrders`.
#[derive(Clone, Copy)]
enum Anchored {
    /// `blocks[block].imageZOrder`
    Image(usize),
    /// `blocks[block].textboxes[textbox].z`
    Box(usize, usize),
}

impl Anchored {
    /// `get`
    fn get(self, blocks: &[Block]) -> f64 {
        match self {
            Self::Image(block) => blocks[block].image_z_order.map_or(f64::NAN, |z| z.0),
            Self::Box(block, textbox) => blocks[block]
                .textboxes
                .as_ref()
                .and_then(|boxes| boxes[textbox].z.map(|z| z.0))
                .unwrap_or(f64::NAN),
        }
    }

    /// `set`
    fn set(self, blocks: &mut [Block], rank: f64) {
        match self {
            Self::Image(block) => {
                let b = &mut blocks[block];
                if rank == 0.0 {
                    b.image_z_order.delete();
                } else {
                    b.image_z_order.set(JsNum(rank));
                }
                // raw XML still carries the wild value; flag for save-time harmonization
                b.image_z_order_normalized.set(true);
            }
            // display-only: the box's XML keeps its raw relativeHeight
            Self::Box(block, textbox) => {
                if let Some(boxes) = blocks[block].textboxes.as_mut() {
                    boxes[textbox].z.set(JsNum(rank));
                }
            }
        }
    }
}

/// `normalizeImageZOrders`: when any decoded wp:anchor relativeHeight is
/// wild, re-rank every anchored image and floating box by its decoded value
/// (stable by document order) from 0; rank 0 drops the image's attribute.
pub fn normalize_image_z_orders(blocks: &mut [Block]) {
    // images and floating shapes share Word's z space: rank them together so
    // cross-type overlaps (photo over a background shape) keep their order
    let mut anchored = Vec::new();
    for (index, b) in blocks.iter().enumerate() {
        if b.image_z_order.is_some() {
            anchored.push(Anchored::Image(index));
        }
        for (at, textbox) in b.textboxes.iter().flatten().enumerate() {
            if textbox.z.is_some() {
                anchored.push(Anchored::Box(index, at));
            }
        }
    }
    if !anchored.iter().any(|e| e.get(blocks).abs() > 10000.0) {
        return;
    }
    let mut order: Vec<usize> = (0..anchored.len()).collect();
    order.sort_by(|&x, &y| {
        let by_value = anchored[x].get(blocks) - anchored[y].get(blocks);
        // `x.e.get() - y.e.get() || x.i - y.i`: 0 and NaN fall through
        if by_value != 0.0 && !by_value.is_nan() {
            by_value.total_cmp(&0.0)
        } else {
            x.cmp(&y)
        }
    });
    for (rank, &at) in order.iter().enumerate() {
        anchored[at].set(blocks, rank as f64);
    }
}

/// What `floatTableColumnSpan` returns.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatTableColumnSpan {
    pub left_twips: JsNum,
    pub right_twips: JsNum,
}

/// `floatTableColumnSpan`: column span (twips from the column's left edge,
/// wrap gaps included) of a w:tblpPr table block; it anchors to the block
/// that follows it.
pub fn float_table_column_span(
    block: &Block,
    sect: &SectionSettings,
) -> Option<FloatTableColumnSpan> {
    let model = if *block.r#type == Some(BlockType::Table) {
        block.table.as_ref()
    } else {
        None
    };
    let pos = model.and_then(|model| model.float_pos.as_ref())?;
    let col_widths = model
        .and_then(|model| model.col_widths_twips.as_ref())
        .filter(|widths| !widths.is_empty())?;
    // keyword X (tblpXSpec) resolves at layout time; only numeric X is known here
    if js_regex!(r"\bw:tblpXSpec=").test(
        block
            .original_xml
            .as_ref()
            .and_then(Option::as_deref)
            .unwrap_or(""),
    ) {
        return None;
    }
    let width = col_widths.iter().fold(0.0, |sum, w| sum + w.0);
    let gap = pos.distance_twips.as_ref();
    let gap_left = gap.and_then(|gap| (*gap.left).map(|left| left.0));
    let gap_right = gap.and_then(|gap| (*gap.right).map(|right| right.0));
    // omitted w:horzAnchor means page-relative
    let x = if matches!(
        pos.horz_anchor,
        Some(TableModelFloatPosHorzAnchor::Page) | None
    ) {
        pos.x_twips.0 - sect.margin_left.0
    } else {
        pos.x_twips.0
    };
    Some(FloatTableColumnSpan {
        left_twips: JsNum(x - gap_left.unwrap_or(0.0)),
        right_twips: JsNum(x + width + gap_right.unwrap_or(0.0)),
    })
}

/// `isEmptyParagraph`
fn is_empty_paragraph(b: &Block) -> bool {
    *b.r#type == Some(BlockType::Paragraph)
        && b.runs.as_ref().is_none_or(|runs| {
            runs.iter()
                .all(|r| trim(r.text.as_deref().unwrap_or("")).is_empty() && r.image.is_none())
        })
}

/// `bandWrappedBoxesBeforeTables`: Word never lays a table beside anchored
/// objects, so a paragraph whose side-wrapped boxes all float, followed
/// (past empty paragraphs) by a table, reserves the boxes' band.
pub fn band_wrapped_boxes_before_tables(blocks: &mut [Block]) {
    for i in 0..blocks.len() {
        let Some(boxes) = blocks[i].textboxes.as_ref() else {
            continue;
        };
        if boxes.is_empty() || !boxes.iter().all(|b| *b.floating == Some(true)) {
            continue;
        }
        let mut j = i + 1;
        while j < blocks.len() && is_empty_paragraph(&blocks[j]) {
            j += 1;
        }
        if blocks.get(j).and_then(|b| *b.r#type) != Some(BlockType::Table) {
            continue;
        }
        for b in blocks[i].textboxes.as_mut().into_iter().flatten() {
            if *b.wrap_sides != Some(true)
                || b.band_bottom_px.is_some()
                || *b.page_pinned == Some(true)
                || *b.page_rel_v == Some(true)
            {
                continue;
            }
            let Some(height_px) = b.height_px.map(|height| height.0) else {
                continue;
            };
            let top = math_round(b.offset_y_emu.map_or(0.0, |offset| offset.0) / EMU_PER_PX);
            if top + height_px <= 0.0 {
                continue;
            }
            b.band_top_px.set(JsNum(top));
            b.band_bottom_px.set(JsNum(top + height_px));
            b.band_beside.set(true);
        }
    }
}
