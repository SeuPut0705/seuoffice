//! The header/footer part writers of patch.ts: a part regenerated from its
//! model (the original's non-text children kept as their bytes), the
//! in-place watermark patch, and the removal of a section's header/footer
//! reference.

use std::collections::{HashMap, HashSet};

use jscompat::{RegexLimit, js_regex, math_round, number_to_string};

use super::thrown;
use crate::generate::props::merge_p_pr_format;
use crate::generate::runs::{RunsXmlOptions, inline_runs_xml_with};
use crate::generate::text_patch::{
    CellParaPatch, CellRichPara, CellTextsPatch, TableTexts, patch_table_cell_texts_with,
};
use crate::generate::{escape_xml_text, split_xml_children};
use crate::inline_opaque::ContentControlPart;
use crate::model::{HeaderFooter, HfParagraph, HfTableCell, ParaFormat, Run};
use crate::parse::tables::hf_fields::{PAGE_MARK, SECTION_PAGES_MARK, TOTAL_PAGES_MARK};
use crate::parse::tables::hf_root::{
    HfRootName, hf_kept_root, hf_root_attrs, hf_wrap_namespaces, is_text_para,
};
use crate::revision_xml::apply_revision_resolutions;
use crate::watermark::is_watermark_child;
use crate::xml_tag::{TagName, find_start_tag};

/// `withWatermarkNs`: the namespaces a VML watermark needs added to the
/// original part's root tag (the ones it declares are untouched).
pub fn with_watermark_ns(open_tag: &str) -> String {
    let mut out = open_tag.to_owned();
    for ns in [
        "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"",
        "xmlns:v=\"urn:schemas-microsoft-com:vml\"",
        "xmlns:o=\"urn:schemas-microsoft-com:office:office\"",
        "xmlns:w10=\"urn:schemas-microsoft-com:office:word\"",
    ] {
        let declared = format!("{}=", ns.split('=').next().unwrap_or_default());
        if !out.contains(&declared) && out.ends_with('>') {
            out.pop();
            out.push_str(&format!(" {ns}>"));
        }
    }
    out
}

/// `patchWatermarkInPart`: the in-place patch for a watermark-only change: the
/// old watermark paragraph goes, the new one goes in at the start of the part
/// and everything else stays byte-identical. None when the root tag cannot be
/// recognized, so the caller falls back to a full rebuild.
pub fn patch_watermark_in_part(
    original_xml: &str,
    watermark_xml: &str,
) -> Result<Option<String>, String> {
    let Some(root) = find_start_tag(original_xml, TagName::Exact("w:hdr"), 0) else {
        return Ok(None);
    };
    let Some(close_at) = original_xml.rfind("</w:hdr>") else {
        return Ok(None);
    };
    let prefix = &original_xml[..root.start];
    // `slice(openIdx + open.length, closeIdx)`: empty when the close tag lies inside the open tag
    let inner = original_xml.get(root.end..close_at).unwrap_or_default();
    let kept: String = split_xml_children(inner)
        .map_err(thrown)?
        .into_iter()
        .filter(|(name, xml)| !is_watermark_child(name, xml))
        .map(|(_, xml)| xml)
        .collect();
    let root_open = if watermark_xml.is_empty() {
        root.text.to_owned()
    } else {
        with_watermark_ns(root.text)
    };
    Ok(Some(format!(
        "{prefix}{root_open}{watermark_xml}{kept}</w:hdr>"
    )))
}

/// `hfOriginalXml`: the part's bytes with the editor's accept / reject
/// decisions replayed (the regeneration basis).
pub fn hf_original_xml(
    hf: &HeaderFooter,
    original_xml: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(original) = original_xml.filter(|xml| !xml.is_empty()) else {
        return Ok(original_xml.map(str::to_owned));
    };
    let Some(resolved) = hf.revisions_resolved.as_ref().filter(|r| !r.is_empty()) else {
        return Ok(Some(original.to_owned()));
    };
    let value = serde_json::to_value(resolved).map_err(thrown)?;
    Ok(Some(
        apply_revision_resolutions(original, Some(&value))?.into_owned(),
    ))
}

/// `removeHfReference`: drop a sectPr's header/footer reference of one variant
/// (default also covers Word's odd and untyped).
pub fn remove_hf_reference(sect_xml: &str, kind: &str, variant: &str) -> Result<String, String> {
    let pattern =
        jscompat::TryJsRegex::new(&format!(r"<w:{kind}Reference\b[^>]*\/>"), "").map_err(thrown)?;
    pattern
        .try_replace_all(sect_xml, |found| {
            let tag = found.as_str();
            // quote-agnostic, like hfReferenceType / onOffTagIn
            let attr = js_regex!(r#"\bw:type=(?:"([^"]+)"|'([^']*)')"#).exec(tag);
            let kind_of = attr.as_ref().and_then(|m| m.get(1).or_else(|| m.get(2)));
            let is_default = matches!(kind_of, None | Some("default") | Some("odd"));
            let drop = if variant == "default" {
                is_default
            } else {
                kind_of == Some(variant)
            };
            if drop { String::new() } else { tag.to_owned() }
        })
        .map_err(thrown)
}

fn text_run(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        format!(
            "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            escape_xml_text(text)
        )
    }
}

const FIELD_BEGIN: &str = "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>";
const FIELD_SEPARATE: &str = "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>";
const FIELD_END: &str = "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>";

fn field_xml(instruction: &str, result: &str) -> String {
    format!(
        "{FIELD_BEGIN}<w:r><w:instrText xml:space=\"preserve\"> {instruction} </w:instrText></w:r>{FIELD_SEPARATE}<w:r><w:t>{result}</w:t></w:r>{FIELD_END}"
    )
}

fn run_text(run: &Run) -> &str {
    run.text.as_deref().unwrap_or_default()
}

fn with_text(run: &Run, text: &str) -> Run {
    let mut copy = run.clone();
    copy.text.set(text.to_owned());
    copy
}

/// `hfRunsXml` and the state it closes over: the runs of one paragraph of a
/// rich header/footer written as XML, PAGE / NUMPAGES / SECTIONPAGES marks as fields.
struct HfRuns<'a> {
    controls: &'a ContentControlPart,
    page_field: String,
    num_pages_field: String,
    section_pages_field: String,
    page_emitted: bool,
}

impl HfRuns<'_> {
    fn runs_xml(&mut self, para_runs: &[Run]) -> Result<String, RegexLimit> {
        let mut xml = String::new();
        // A paragraph with wrappers goes through the same grouping as the body,
        // including neighbouring runs of a hyperlink crossing a wrapper.
        let grouped = para_runs
            .iter()
            .any(|run| run.wrap.as_ref().is_some_and(|wrap| !wrap.is_empty()));
        let mut opts = RunsXmlOptions {
            written: HashSet::new(),
            fragments: HashMap::new(),
            part: Some(self.controls),
        };
        let mut held: Vec<Run> = Vec::new();
        // `text(piece)`
        let text = |xml: &mut String,
                    held: &mut Vec<Run>,
                    opts: &mut RunsXmlOptions<'_>,
                    piece: Run|
         -> Result<(), RegexLimit> {
            if grouped {
                held.push(piece);
            } else {
                xml.push_str(&inline_runs_xml_with(&[piece], opts)?);
            }
            Ok(())
        };
        // `field(fieldXml, host, logicalText)`: the logical field mark stays for the control's changed-text test
        let field = |xml: &mut String,
                     held: &mut Vec<Run>,
                     opts: &mut RunsXmlOptions<'_>,
                     field_xml: &str,
                     host: &Run,
                     logical_text: &str| {
            if grouped {
                opts.fragments.insert(held.len(), field_xml.to_owned());
                held.push(with_text(host, logical_text));
            } else {
                xml.push_str(field_xml);
            }
        };
        let total_mark = TOTAL_PAGES_MARK;
        let section_mark = SECTION_PAGES_MARK;
        for run in para_runs {
            let run_text = run_text(run);
            if run_text.contains(total_mark)
                || run_text.contains(section_mark)
                || run_text.contains(PAGE_MARK)
                || (!self.page_emitted && run_text.contains('#'))
            {
                // SECTIONPAGES and NUMPAGES split alike: a mark between two segments is its field
                let mut segments: Vec<(bool, &str)> = Vec::new();
                let mut from = 0;
                for (at, c) in run_text.char_indices() {
                    if c == total_mark || c == section_mark {
                        segments.push((false, &run_text[from..at]));
                        segments.push((true, &run_text[at..at + c.len_utf8()]));
                        from = at + c.len_utf8();
                    }
                }
                segments.push((false, &run_text[from..]));
                for (is_mark, seg) in segments {
                    if is_mark {
                        let xml_field = if seg.starts_with(section_mark) {
                            self.section_pages_field.clone()
                        } else {
                            self.num_pages_field.clone()
                        };
                        field(&mut xml, &mut held, &mut opts, &xml_field, run, seg);
                        continue;
                    }
                    if seg.contains(PAGE_MARK) {
                        for (j, piece) in seg.split(PAGE_MARK).enumerate() {
                            if j > 0 {
                                let mark = PAGE_MARK.to_string();
                                field(&mut xml, &mut held, &mut opts, &self.page_field, run, &mark);
                            }
                            if !piece.is_empty() {
                                text(&mut xml, &mut held, &mut opts, with_text(run, piece))?;
                            }
                        }
                    } else if !self.page_emitted && seg.contains('#') {
                        let (before, rest) = seg.split_once('#').unwrap_or((seg, ""));
                        if !before.is_empty() {
                            text(&mut xml, &mut held, &mut opts, with_text(run, before))?;
                        }
                        field(&mut xml, &mut held, &mut opts, &self.page_field, run, "#");
                        if !rest.is_empty() {
                            text(&mut xml, &mut held, &mut opts, with_text(run, rest))?;
                        }
                        self.page_emitted = true;
                    } else if !seg.is_empty() {
                        text(&mut xml, &mut held, &mut opts, with_text(run, seg))?;
                    }
                }
            } else {
                text(&mut xml, &mut held, &mut opts, run.clone())?;
            }
        }
        if !held.is_empty() {
            xml.push_str(&inline_runs_xml_with(&held, &mut opts)?);
        }
        Ok(xml)
    }
}

/// `para.cells.flatMap(c => c.paras)`-style: the paragraphs of a cell, one empty one where it has none.
fn cell_paras(cell: &HfTableCell) -> Vec<&[Run]> {
    if cell.paras.is_empty() {
        vec![&[][..]]
    } else {
        cell.paras.iter().map(Vec::as_slice).collect()
    }
}

/// `row paragraphs`: the paragraphs of a layout-table row written flat, for a rebuild without the original part.
fn row_paras(writer: &mut HfRuns<'_>, para: &HfParagraph) -> Result<String, RegexLimit> {
    let mut out = String::new();
    for cell in para.cells.as_deref().unwrap_or_default() {
        for runs in cell_paras(cell) {
            out.push_str(&format!("<w:p>{}</w:p>", writer.runs_xml(runs)?));
        }
    }
    Ok(out)
}

/// `cellPatches`: the edited layout-table cells of the `tbl_index`-th top-level w:tbl.
fn cell_patches(
    writer: &mut HfRuns<'_>,
    paras: &[HfParagraph],
    tbl_index: usize,
) -> Result<Option<TableTexts>, String> {
    let mut grid: TableTexts = Vec::new();
    for para in paras {
        let source = para.row.as_ref().and_then(|row| row.source.as_ref());
        let Some(source) = source.filter(|source| source.tbl.0 == tbl_index as f64) else {
            continue;
        };
        let tr = source.tr.0;
        let cells = para.cells.as_deref().unwrap_or_default();
        if !cells.iter().any(|cell| cell.rewrite.is_some()) {
            continue;
        }
        // a row index that is no array index sets no element, and the grid keeps its length;
        // none past a million rows can match a table row
        if !(tr >= 0.0 && tr.fract() == 0.0 && tr < 1_048_576.0) {
            continue;
        }
        let tr = tr as usize;
        let mut row: Vec<Option<CellTextsPatch>> = Vec::new();
        for cell in cells {
            if cell.rewrite.is_none() {
                row.push(None);
                continue;
            }
            let mut patches: Vec<Option<CellParaPatch>> = Vec::new();
            for (k, runs) in cell_paras(cell).into_iter().enumerate() {
                let mut rich = CellRichPara {
                    runs: runs.to_vec(),
                    xml: Some(writer.runs_xml(runs).map_err(thrown)?),
                    format: None,
                    original: None,
                };
                if cell
                    .rewrite_format
                    .as_ref()
                    .is_some_and(|formats| formats.iter().any(|n| n.0 == k as f64))
                {
                    let props = cell
                        .para_props
                        .as_ref()
                        .and_then(|props| props.get(k))
                        .and_then(Option::as_ref);
                    rich.format = Some(match props {
                        Some(props) => para_format_of(props)?,
                        None => ParaFormat::default(),
                    });
                    rich.original = match cell
                        .prior_para_props
                        .as_ref()
                        .and_then(|props| props.get(k))
                        .and_then(Option::as_ref)
                    {
                        Some(props) => Some(para_format_of(props)?),
                        None => None,
                    };
                }
                patches.push(Some(CellParaPatch::Rich(Box::new(rich))));
            }
            row.push(Some(CellTextsPatch::Paras(patches)));
        }
        if grid.len() <= tr {
            grid.resize(tr + 1, None);
        }
        grid[tr] = Some(row);
    }
    Ok((!grid.is_empty()).then_some(grid))
}

/// A cell paragraph's format as the `ParaFormat` the cell patch reads (the object is the same, typed narrower).
fn para_format_of(props: &crate::model::HfCellParaProps) -> Result<ParaFormat, String> {
    let value = serde_json::to_value(props).map_err(thrown)?;
    serde_json::from_value(value).map_err(thrown)
}

fn js_slice_from(text: &str, from: usize, to: usize) -> &str {
    if from >= to { "" } else { &text[from..to] }
}

/// `headerFooterPartXml`: a standalone header/footer part, centered text with
/// an optional PAGE field, or the rich paragraphs of `hf`. PAGE_MARK in the text
/// marks where the page number goes; a typed `#` still counts when no PAGE_MARK
/// exists. `watermark_xml`: None keeps the part's own watermark child, `Some("")`
/// drops it, otherwise it replaces it.
pub fn header_footer_part_xml(
    kind: &str,
    hf: &HeaderFooter,
    watermark_xml: Option<&str>,
    original_xml: Option<&str>,
    page_count: f64,
) -> Result<String, String> {
    header_footer_part_xml_within(
        MAX_SDT_DEPTH,
        kind,
        hf,
        watermark_xml,
        original_xml,
        page_count,
    )
}

/// `header_footer_part_xml` with the nesting depth of block controls it
/// follows given (a test passes a small one: the walk is quadratic in depth).
fn header_footer_part_xml_within(
    max_sdt_depth: usize,
    kind: &str,
    hf: &HeaderFooter,
    watermark_xml: Option<&str>,
    original_xml: Option<&str>,
    page_count: f64,
) -> Result<String, String> {
    let root = if kind == "header" {
        HfRootName::Hdr
    } else {
        HfRootName::Ftr
    };
    let original_xml = original_xml.filter(|xml| !xml.is_empty());
    // Which root the part ends up under is known before its runs are written: a
    // wrapper is written only when that root declares the prefixes it uses.
    let kept = match original_xml {
        Some(original) => hf_kept_root(root, original).map_err(thrown)?,
        None => None,
    };
    let namespaces = hf_wrap_namespaces(original_xml, kept.is_some()).map_err(thrown)?;
    let controls = ContentControlPart::new(&[original_xml.unwrap_or_default()], Some(namespaces));
    let rounded = math_round(page_count);
    let pages = if rounded.is_nan() {
        rounded
    } else {
        rounded.max(1.0)
    };
    let mut writer = HfRuns {
        controls: &controls,
        page_field: field_xml("PAGE", "1"),
        num_pages_field: field_xml("NUMPAGES", &number_to_string(pages)),
        section_pages_field: field_xml("SECTIONPAGES", "1"),
        page_emitted: false,
    };
    let content: String;
    let mut paras_for_cells: &[HfParagraph] = &[];
    if let Some(paras) = hf.paras.as_ref() {
        // rich paragraphs; every PAGE_MARK becomes a PAGE field and every
        // TOTAL_PAGES_MARK a NUMPAGES field. Only when no PAGE_MARK exists does a
        // typed '#' stand in (first occurrence only)
        let has_page_mark = paras.iter().any(|p| {
            p.runs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .any(|r| run_text(r).contains(PAGE_MARK))
                || p.cells.as_deref().unwrap_or_default().iter().any(|c| {
                    c.paras
                        .iter()
                        .any(|rs| rs.iter().any(|r| run_text(r).contains(PAGE_MARK)))
                })
        });
        writer.page_emitted = hf.page_number != Some(true) || has_page_mark;
        let mut out = String::new();
        for para in paras {
            // still-empty drawing-only lines are display-only: the part's original
            // drawing paragraph bytes are kept below
            let runs = para.runs.as_deref().unwrap_or_default();
            if *para.line_only == Some(true) && original_xml.is_some() && runs.is_empty() {
                continue;
            }
            if para.cells.is_some() {
                if original_xml.is_none() {
                    out.push_str(&row_paras(&mut writer, para).map_err(thrown)?);
                }
                continue;
            }
            // the parsed format, not just w:jc: hand-building it dropped w:bidi
            let p_pr = merge_p_pr_format("<w:pPr/>", Some(&para.para_format), None, None)
                .map_err(thrown)?;
            out.push_str(&format!(
                "<w:p>{p_pr}{}</w:p>",
                writer.runs_xml(runs).map_err(thrown)?
            ));
        }
        if !writer.page_emitted {
            out.push_str(&format!(
                "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{}</w:p>",
                writer.page_field
            ));
        }
        paras_for_cells = paras;
        content = out;
    } else {
        let text_with_total = |t: &str| -> String {
            t.split(SECTION_PAGES_MARK)
                .map(|s| {
                    s.split(TOTAL_PAGES_MARK)
                        .map(text_run)
                        .collect::<Vec<_>>()
                        .join(&writer.num_pages_field)
                })
                .collect::<Vec<_>>()
                .join(&writer.section_pages_field)
        };
        let mut runs: Vec<String> = Vec::new();
        if hf.text.contains(PAGE_MARK) {
            runs.push(
                hf.text
                    .split(PAGE_MARK)
                    .map(text_with_total)
                    .collect::<Vec<_>>()
                    .join(&writer.page_field),
            );
        } else if hf.page_number == Some(true) && hf.text.contains('#') {
            let (before, rest) = hf.text.split_once('#').unwrap_or((&hf.text, ""));
            runs.push(text_with_total(before));
            runs.push(writer.page_field.clone());
            runs.push(text_with_total(rest));
        } else {
            if !hf.text.is_empty() {
                let spaced = format!(
                    "{}{}",
                    hf.text,
                    if hf.page_number == Some(true) {
                        " "
                    } else {
                        ""
                    }
                );
                runs.push(text_with_total(&spaced));
            }
            if hf.page_number == Some(true) {
                runs.push(writer.page_field.clone());
            }
        }
        content = format!(
            "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{}</w:p>",
            runs.concat()
        );
    }
    let body = format!("{}{content}", watermark_xml.unwrap_or_default());
    // Surgical merge: non-paragraph children of the original part (tables, sdt) and
    // paragraphs holding images or objects (logos, not in the text-paragraph model)
    // keep their original bytes; the set of text paragraphs is replaced as a whole
    // at the position of the first one. The watermark child is kept verbatim unless
    // `watermark_xml` replaces or drops it.
    if let Some(kept) = kept {
        let mut parts: Vec<String> = Vec::new();
        let mut injected = false;
        // tables are numbered the way the parser walks them (through w:sdt wrappers)
        let mut tbl_index = 0usize;
        for (name, xml) in &kept.children {
            if is_text_para(name, xml) {
                if !injected {
                    parts.push(body.clone());
                    injected = true;
                }
            } else if is_watermark_child(name, xml) && watermark_xml.is_some() {
                // superseded by the watermark in body (or removed)
            } else if name == "w:tbl" {
                parts.push(patch_table(
                    &mut writer,
                    paras_for_cells,
                    &mut tbl_index,
                    xml,
                    &controls,
                )?);
            } else if name == "w:sdt" {
                parts.push(patch_sdt(
                    &mut writer,
                    paras_for_cells,
                    &mut tbl_index,
                    xml,
                    &controls,
                    max_sdt_depth,
                )?);
            } else {
                parts.push(xml.clone());
            }
        }
        if !injected {
            parts.insert(0, body);
        }
        let root_open = if watermark_xml.is_some_and(|xml| !xml.is_empty()) {
            with_watermark_ns(&kept.open)
        } else {
            kept.open.clone()
        };
        return controls
            .finish(&format!(
                "{}{root_open}{}</{}>",
                kept.before,
                parts.concat(),
                root.as_str()
            ))
            .map_err(thrown);
    }
    controls
        .finish(&format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<{root}{}>{body}</{root}>",
            hf_root_attrs(),
            root = root.as_str(),
        ))
        .map_err(thrown)
}

/// `patchTable`: the edited cells patched into one table's bytes.
fn patch_table(
    writer: &mut HfRuns<'_>,
    paras: &[HfParagraph],
    tbl_index: &mut usize,
    xml: &str,
    controls: &ContentControlPart,
) -> Result<String, String> {
    let grid = cell_patches(writer, paras, *tbl_index)?;
    *tbl_index += 1;
    match grid {
        Some(grid) => patch_table_cell_texts_with(xml, &grid, controls).map_err(thrown),
        None => Ok(xml.to_owned()),
    }
}

/// The start tag of an element (`findStartTag(xml)?.text`), or "".
fn open_of(xml: &str) -> &str {
    find_start_tag(xml, TagName::Any, 0).map_or("", |tag| tag.text)
}

/// The end tag an element ends with, or "".
fn close_of(xml: &str) -> &str {
    // `/<\/[^>]*>$/`, without a scan of the whole part: the match is the last
    // tag when the part ends with `>`, from the leftmost `</` after the `>`
    // before it (`[^>]*` cannot cross a `>`). One pass over the part per
    // nesting level was quadratic in the depth of block controls.
    let Some(body) = xml.strip_suffix('>') else {
        return "";
    };
    let from = body.rfind('>').map_or(0, |at| at + 1);
    body[from..].find("</").map_or("", |at| &xml[from + at..])
}

fn inner_xml(xml: &str) -> &str {
    js_slice_from(xml, open_of(xml).len(), xml.len() - close_of(xml).len())
}

fn rewrap(xml: &str, children: &[String]) -> String {
    format!("{}{}{}", open_of(xml), children.concat(), close_of(xml))
}

/// Nested block controls `patch_sdt` follows. The TypeScript recurses and hits
/// its own stack limit (a RangeError, with no catch around it) at some depth
/// of thousands; past this bound the engine returns the same error.
const MAX_SDT_DEPTH: usize = 1000;

type Children = std::vec::IntoIter<(String, String)>;

/// One level of `patch_sdt`'s walk: a control (`Sdt`) or its `w:sdtContent`.
enum SdtFrame {
    Sdt {
        xml: String,
        done: Vec<String>,
        rest: Children,
    },
    Content {
        xml: String,
        inner: Vec<String>,
        rest: Children,
    },
}

fn sdt_frame(xml: String) -> Result<SdtFrame, String> {
    let rest = split_xml_children(inner_xml(&xml))
        .map_err(thrown)?
        .into_iter();
    Ok(SdtFrame::Sdt {
        xml,
        done: Vec::new(),
        rest,
    })
}

/// `patchSdt`: a block control's tables patched, through nested controls. An
/// explicit stack, not a recursion: a document drives the nesting depth.
fn patch_sdt(
    writer: &mut HfRuns<'_>,
    paras: &[HfParagraph],
    tbl_index: &mut usize,
    sdt_xml: &str,
    controls: &ContentControlPart,
    max_depth: usize,
) -> Result<String, String> {
    let mut stack: Vec<SdtFrame> = vec![sdt_frame(sdt_xml.to_owned())?];
    loop {
        let Some(top) = stack.last_mut() else {
            unreachable!("the walk returns when the outermost control is finished");
        };
        match top {
            SdtFrame::Sdt { xml, done, rest } => match rest.next() {
                Some((name, child)) if name == "w:sdtContent" => {
                    let inner = split_xml_children(inner_xml(&child))
                        .map_err(thrown)?
                        .into_iter();
                    stack.push(SdtFrame::Content {
                        xml: child,
                        inner: Vec::new(),
                        rest: inner,
                    });
                }
                Some((_, child)) => done.push(child),
                None => {
                    let result = rewrap(xml, done);
                    stack.pop();
                    match stack.last_mut() {
                        Some(SdtFrame::Content { inner, .. }) => inner.push(result),
                        _ => return Ok(result),
                    }
                }
            },
            SdtFrame::Content { xml, inner, rest } => match rest.next() {
                Some((name, child)) => match name.as_str() {
                    "w:tbl" => inner.push(patch_table(writer, paras, tbl_index, &child, controls)?),
                    "w:sdt" => {
                        if stack.len() >= max_depth * 2 {
                            return Err("RangeError: Maximum call stack size exceeded".to_owned());
                        }
                        stack.push(sdt_frame(child)?);
                    }
                    _ => inner.push(child),
                },
                None => {
                    let result = rewrap(xml, inner);
                    stack.pop();
                    if let Some(SdtFrame::Sdt { done, .. }) = stack.last_mut() {
                        done.push(result);
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nested_header(depth: usize) -> String {
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:hdr \
             xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
        );
        for _ in 0..depth {
            xml.push_str("<w:sdt><w:sdtPr/><w:sdtContent>");
        }
        xml.push_str("<w:p><w:r><w:t>x</w:t></w:r></w:p>");
        for _ in 0..depth {
            xml.push_str("</w:sdtContent></w:sdt>");
        }
        xml.push_str("</w:hdr>");
        xml
    }

    fn run(max_depth: usize, depth: usize) -> Result<String, String> {
        header_footer_part_xml_within(
            max_depth,
            "header",
            &HeaderFooter::default(),
            None,
            Some(&nested_header(depth)),
            1.0,
        )
    }

    #[test]
    fn controls_nested_to_the_bound_are_walked_in_a_loop() {
        // the walk costs a pass over what is left of the part per level, so the
        // bound a test uses is small; the real one only changes the number
        let out = run(40, 40).expect("depth within the bound");
        assert_eq!(out.matches("<w:sdt>").count(), 40);
    }

    #[test]
    fn controls_nested_past_the_bound_are_the_engine_error() {
        let error = run(40, 41).expect_err("past the bound");
        assert!(
            error.contains("Maximum call stack size exceeded"),
            "{error}"
        );
    }

    #[test]
    fn the_end_tag_is_what_the_regex_finds_over_every_short_string() {
        // every string of up to 6 characters from the alphabet that matters
        let pattern = jscompat::try_js_regex!(r"<\/[^>]*>$");
        let alphabet = ['<', '/', '>', 'a', '\n'];
        let mut count = 0;
        for length in 0..=6usize {
            for n in 0..alphabet.len().pow(length as u32) {
                let text: String = (0..length)
                    .map(|k| alphabet[n / alphabet.len().pow(k as u32) % alphabet.len()])
                    .collect();
                let expected = pattern
                    .try_exec(&text)
                    .unwrap()
                    .map_or("", |found| found.as_str());
                assert_eq!(close_of(&text), expected, "{text:?}");
                count += 1;
            }
        }
        assert!(count > 19_000);
    }

    #[test]
    fn the_end_tag_of_a_part_is_its_last_tag() {
        assert_eq!(close_of("<a><b>t</b></a>"), "</a>");
        assert_eq!(close_of("<a>t</a\n>"), "</a\n>");
        assert_eq!(close_of("<a>x < y</a>"), "</a>");
        assert_eq!(close_of("</>"), "</>");
        assert_eq!(close_of("<a>t<b/>"), "");
        assert_eq!(close_of("<a>t</a> "), "");
        assert_eq!(close_of(""), "");
    }
}
