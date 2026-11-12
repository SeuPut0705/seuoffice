//! `page/hf.ts`: header/footer write-back: which parts of the edited docx
//! changed, and the ODF of a master page region rebuilt from an edited part.

use std::collections::HashMap;

use docx_engine::model::{HfParagraph, Run};
use docx_engine::parse::drawings::host::NoHost;
use docx_engine::parse::parse_docx;
use docx_engine::parse::tables::hf_fields::{PAGE_MARK, TOTAL_PAGES_MARK};
use jscompat::{JsMap, js_regex, trim};
use ooxml_pkg::{Package, Part, write::generate};
use serde_json::{Map, Value};

use crate::core::convert::{
    BridgeMarkerKind, BridgeParagraph, BridgeParagraphElement, EditedParagraph,
    EditedParagraphType, OoxmlToOdfContext, ParagraphWriteEnv, RunWriter,
};
use crate::core::errors::OdtError;
use crate::core::styles::{OdtMasterPageRegion, OdtStylePart};
use crate::core::xml::escape_xml_attr;
use crate::offset::IndexedText;
use crate::text::paragraph_odf::{ParagraphWriteOptions, paragraph_to_odf};
use crate::text::paragraph_ooxml::paragraph_style_info;

use super::model::{PAGE_OWNER, PageExt, PageHfPart};
use super::odf::child_elements;

const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// `EditedPart`: an edited header/footer part as the write-back sees it.
#[derive(Debug, Clone)]
pub struct EditedPart {
    pub r_id: String,
    /// byte-identical to the bridge part
    pub unchanged: bool,
    /// paragraphs of the edited part (tables are display-only rows and left out)
    pub paragraphs: Vec<HfParagraph>,
}

/// `JSZip.loadAsync(bytes)` over the plain entries of a zip.
fn load_plain(bytes: &[u8]) -> Result<Package, OdtError> {
    let entries = ooxml_pkg::read_entries(bytes).map_err(|e| OdtError::thrown(e.to_string()))?;
    let mut package = Package::default();
    for entry in entries {
        let name = String::from_utf8_lossy(&entry.raw_name).into_owned();
        package.set(Part::new(name, entry.is_dir, entry.content));
    }
    Ok(package)
}

fn part_string(package: &Package, path: &str) -> Result<Option<String>, OdtError> {
    package
        .text(path)
        .map(|text| text.map(str::to_owned))
        .map_err(|e| OdtError::thrown(e.to_string()))
}

/// `readEditedParts`: reads the header/footer parts the edited sections reference.
pub fn read_edited_parts(
    rctx: &OoxmlToOdfContext,
    ext: &PageExt,
    r_ids: &[String],
) -> Result<JsMap<EditedPart>, OdtError> {
    let mut out = JsMap::new();
    let mut wanted: Vec<&String> = Vec::new();
    for id in r_ids {
        if !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    if wanted.is_empty() {
        return Ok(out);
    }
    let zip = load_plain(&rctx.edited.internal.original_bytes.0)?;
    let rels_xml = part_string(&zip, "word/_rels/document.xml.rels")?.unwrap_or_default();
    let mut targets: JsMap<String> = JsMap::new();
    for m in js_regex!(r"<Relationship\b[^>]*>").find_iter(&rels_xml) {
        let id = js_regex!(r#"\bId="([^"]*)""#)
            .exec(m.as_str())
            .and_then(|x| x.get(1));
        let target = js_regex!(r#"\bTarget="([^"]*)""#)
            .exec(m.as_str())
            .and_then(|x| x.get(1));
        if let (Some(id), Some(target)) = (id, target) {
            if !id.is_empty() && !target.is_empty() {
                targets.set(id, target.to_owned());
            }
        }
    }
    for r_id in wanted {
        let paragraphs: Vec<HfParagraph> = rctx
            .edited
            .hf_parts
            .as_ref()
            .and_then(|parts| parts.get(r_id))
            .map(|part| {
                part.paras
                    .iter()
                    .filter(|p| p.cells.is_none())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let bridge = ext.parts.get(r_id);
        let mut unchanged = false;
        if let Some(bridge) = bridge {
            let path = match targets.get(r_id).filter(|t| !t.is_empty()) {
                Some(target) => match target.strip_prefix('/') {
                    Some(rest) => rest.to_owned(),
                    // `target.replace(/^\.\//, '')`
                    None => format!("word/{}", target.strip_prefix("./").unwrap_or(target)),
                },
                None => bridge.path.clone(),
            };
            let xml = part_string(&zip, &path)?;
            unchanged = xml.as_deref() == Some(bridge.xml.as_str());
        }
        out.set(
            r_id.clone(),
            EditedPart {
                r_id: r_id.clone(),
                unchanged,
                paragraphs,
            },
        );
    }
    Ok(out)
}

/// `baselineParagraphs`: the bridge parts read back by the docx engine (with
/// the edited docx's styles), so edited paragraphs can be compared with what
/// the editor was given.
pub fn baseline_paragraphs(
    parts: &[PageHfPart],
    styles_xml: Option<&str>,
) -> Result<JsMap<Vec<HfParagraph>>, OdtError> {
    let mut out = JsMap::new();
    if parts.is_empty() {
        return Ok(out);
    }
    let decl = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
    let ct = "application/vnd.openxmlformats-officedocument.wordprocessingml";
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut add = |name: &str, data: String| files.push((name.to_owned(), data.into_bytes()));
    let overrides: String = parts
        .iter()
        .map(|p| {
            format!(
                "<Override PartName=\"/{}\" ContentType=\"{ct}.{}+xml\"/>",
                p.path,
                p.kind.as_str()
            )
        })
        .collect();
    add(
        "[Content_Types].xml",
        format!(
            "{decl}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"{ct}.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"{ct}.styles+xml\"/>{overrides}</Types>"
        ),
    );
    add(
        "_rels/.rels",
        format!(
            "{decl}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"{REL_BASE}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
        ),
    );
    let rels: String = parts
        .iter()
        .map(|p| {
            format!(
                "<Relationship Id=\"{}\" Type=\"{REL_BASE}/{}\" Target=\"{}\"/>",
                escape_xml_attr(&p.r_id),
                p.kind.as_str(),
                escape_xml_attr(p.path.strip_prefix("word/").unwrap_or(&p.path))
            )
        })
        .collect();
    add(
        "word/_rels/document.xml.rels",
        format!(
            "{decl}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rIdStyles\" Type=\"{REL_BASE}/styles\" Target=\"styles.xml\"/>{rels}</Relationships>"
        ),
    );
    add(
        "word/styles.xml",
        styles_xml.map(str::to_owned).unwrap_or_else(|| {
            format!("{decl}<w:styles xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>")
        }),
    );
    let refs: String = parts
        .iter()
        .map(|p| {
            format!(
                "<w:{}Reference w:type=\"default\" r:id=\"{}\"/>",
                p.kind.as_str(),
                escape_xml_attr(&p.r_id)
            )
        })
        .collect();
    add(
        "word/document.xml",
        format!(
            "{decl}<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"{REL_BASE}\"><w:body><w:p/><w:sectPr>{refs}</w:sectPr></w:body></w:document>"
        ),
    );
    for p in parts {
        add(&p.path, p.xml.clone());
    }
    let package = Package::from_parts(files);
    // the clock only stamps the zip entries; the parse does not read it
    let bytes =
        generate(&package, 946_684_800_000.0).map_err(|e| OdtError::thrown(e.to_string()))?;
    let parsed = parse_docx(&bytes, &NoHost).map_err(OdtError::thrown)?;
    for p in parts {
        let paras: Vec<HfParagraph> = parsed
            .hf_parts
            .as_ref()
            .and_then(|hf| hf.get(&p.r_id))
            .map(|part| {
                part.paras
                    .iter()
                    .filter(|x| x.cells.is_none())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        out.set(p.r_id.clone(), paras);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Paragraph comparison

/// `PARAGRAPH_ONLY`
const PARAGRAPH_ONLY: [&str; 8] = [
    "runs",
    "cells",
    "row",
    "lineOnly",
    "frameXAlign",
    "boxAnchored",
    "box",
    "ptabAligns",
];

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// `hfFormat`: the paragraph-format part of a header paragraph, keys in the
/// order the paragraph holds them.
pub fn hf_format(p: &HfParagraph) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(fields) = to_value(p) {
        for (k, v) in fields {
            if !PARAGRAPH_ONLY.contains(&k.as_str()) {
                out.insert(k, v);
            }
        }
    }
    out
}

/// `canonical`: `JSON.stringify` with the keys of every object sorted (by
/// UTF-16 code unit).
pub(super) fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, v)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(v, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out);
            }
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

fn runs_of(p: &HfParagraph) -> &[Run] {
    p.runs.as_deref().unwrap_or(&[])
}

fn same_format(a: &HfParagraph, b: &HfParagraph) -> bool {
    canonical(&Value::Object(hf_format(a))) == canonical(&Value::Object(hf_format(b)))
}

fn same_paragraph(a: &HfParagraph, b: &HfParagraph) -> bool {
    same_format(a, b) && canonical(&to_value(&runs_of(a))) == canonical(&to_value(&runs_of(b)))
}

fn text_of(p: &HfParagraph) -> String {
    runs_of(p)
        .iter()
        .map(|r| r.text.as_deref().unwrap_or(""))
        .collect()
}

/// `pairParagraphs`: pairs original paragraphs with edited ones: equal texts
/// in order (LCS), then a lone leftover on each side of a gap. Returns, per
/// original, the edited index or -1 (deleted).
pub fn pair_paragraphs(original: &[String], edited: &[String]) -> Vec<i64> {
    let n = original.len();
    let m = edited.len();
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if original[i] == edited[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let mut pair = vec![-1i64; n];
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if original[i] == edited[j] {
            pair[i] = j as i64;
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    // gaps between pairs: pair leftovers positionally
    let mut last_o: i64 = -1;
    let mut last_e: i64 = -1;
    let fill = |pair: &mut Vec<i64>, last_o: i64, last_e: i64, to_o: usize, to_e: usize| {
        let mut os: Vec<usize> = Vec::new();
        let mut o = last_o + 1;
        while (o as usize) < to_o {
            if pair[o as usize] < 0 {
                os.push(o as usize);
            }
            o += 1;
        }
        let es: Vec<usize> = ((last_e + 1) as usize..to_e).collect();
        for k in 0..os.len().min(es.len()) {
            pair[os[k]] = es[k] as i64;
        }
    };
    for o in 0..n {
        if pair[o] < 0 {
            continue;
        }
        let edited_at = pair[o] as usize;
        fill(&mut pair, last_o, last_e, o, edited_at);
        last_o = o as i64;
        last_e = pair[o];
    }
    fill(&mut pair, last_o, last_e, n, m);
    pair
}

// ---------------------------------------------------------------------------
// Region rebuild

/// `splitFieldRuns`: header runs with page fields split out, so the field run
/// writer sees them alone.
fn split_field_runs(p: &HfParagraph) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for run in runs_of(p) {
        let text = run.text.as_deref().unwrap_or("");
        if !text.contains(PAGE_MARK) && !text.contains(TOTAL_PAGES_MARK) {
            out.push(run.clone());
            continue;
        }
        let mut pieces: Vec<String> = Vec::new();
        let mut current = String::new();
        for ch in text.chars() {
            if ch == PAGE_MARK || ch == TOTAL_PAGES_MARK {
                pieces.push(std::mem::take(&mut current));
                pieces.push(ch.to_string());
            } else {
                current.push(ch);
            }
        }
        pieces.push(current);
        for piece in pieces.into_iter().filter(|piece| !piece.is_empty()) {
            let mut split = run.clone();
            split.text.set(piece);
            out.push(split);
        }
    }
    out
}

/// `regionInnerXml`: the inner XML of a region rebuilt from an edited part.
/// `source` is the original region the part showed (its paragraphs are
/// `records`, read back as `baseline`), or `None` for a part with no original
/// content.
pub fn region_inner_xml(
    rctx: &mut OoxmlToOdfContext,
    source: Option<&OdtMasterPageRegion>,
    records: &[BridgeParagraph],
    baseline: Option<&[HfParagraph]>,
    edited: &[HfParagraph],
) -> Result<String, OdtError> {
    let info = rctx.part(OdtStylePart::StylesXml);
    let indexed: &IndexedText = &info.xml;
    let xml: &str = &indexed.text;
    let base: Vec<Option<&HfParagraph>> = match baseline {
        Some(b) if b.len() == records.len() => b.iter().map(Some).collect(),
        _ => records.iter().map(|_| None).collect(),
    };
    let original_texts: Vec<String> = records.iter().map(|r| r.text.clone()).collect();
    let edited_texts: Vec<String> = edited.iter().map(text_of).collect();
    let pair = pair_paragraphs(&original_texts, &edited_texts);

    let write = |rctx: &mut OoxmlToOdfContext,
                 para: &HfParagraph,
                 origin: Option<&BridgeParagraph>,
                 baseline_para: Option<&HfParagraph>,
                 follows: Option<&BridgeParagraph>,
                 neighbour: Option<&BridgeParagraph>|
     -> Result<String, OdtError> {
        if let (Some(origin), Some(baseline_para)) = (origin, baseline_para) {
            if same_paragraph(para, baseline_para) {
                return Ok(
                    xml[indexed.to_byte(origin.start)..indexed.to_byte(origin.end)].to_owned(),
                );
            }
        }
        let template = origin.or(follows).or(neighbour);
        let style_id = template.and_then(|r| {
            paragraph_style_info(
                &rctx.doc,
                &rctx.map,
                OdtStylePart::StylesXml,
                r.style_name.as_deref(),
            )
            .style_id
        });
        let raw_p_pr = match (origin, baseline_para) {
            (Some(origin), Some(b)) if same_format(para, b) => Some(origin.p_pr.clone()),
            _ => None,
        };
        let edit = EditedParagraph {
            r#type: EditedParagraphType::Paragraph,
            runs: split_field_runs(para),
            format: Some(para.para_format.clone()),
            style_id,
            level: None,
            outline_only: None,
            list: None,
            raw_p_pr,
            hidden_bookmarks: None,
        };
        paragraph_to_odf(
            rctx,
            &edit,
            origin,
            &ParagraphWriteOptions {
                part: OdtStylePart::StylesXml,
                neighbour: if origin.is_some() { None } else { neighbour },
                follows: if origin.is_some() { None } else { follows },
                ..Default::default()
            },
        )
    };

    let mut out = String::new();
    let mut next_edited = 0usize;
    let mut follows: Option<&BridgeParagraph> = None;
    let by_start: HashMap<usize, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (indexed.to_byte(r.start), i))
        .collect();
    let children = match source {
        Some(source) if !source.self_closing => {
            child_elements(xml, &info.prefixes, source.open_end, source.close_start)
        }
        _ => Vec::new(),
    };
    for child in &children {
        let Some(&index) = by_start.get(&child.start) else {
            out.push_str(&xml[child.start..child.end]);
            continue;
        };
        let record = &records[index];
        let target = pair[index];
        if target < 0 {
            out.push_str(&hidden_objects(indexed, record));
            continue;
        }
        let target = target as usize;
        // `emitNew(target, record)`
        while next_edited < target {
            out.push_str(&write(
                rctx,
                &edited[next_edited],
                None,
                None,
                follows,
                follows.or(Some(record)),
            )?);
            next_edited += 1;
        }
        out.push_str(&write(
            rctx,
            &edited[target],
            Some(record),
            base[index],
            None,
            None,
        )?);
        next_edited = target + 1;
        follows = Some(record);
    }
    // `emitNew(edited.length, records[records.length - 1] ?? null)`
    let last = records.last();
    while next_edited < edited.len() {
        out.push_str(&write(
            rctx,
            &edited[next_edited],
            None,
            None,
            follows,
            follows.or(last),
        )?);
        next_edited += 1;
    }
    Ok(out)
}

/// `hiddenObjects`: what a deleted header/footer paragraph must still leave
/// behind: the objects the editor never showed.
fn hidden_objects(indexed: &IndexedText, record: &BridgeParagraph) -> String {
    let xml = indexed.text.as_str();
    let kept: Vec<_> = record
        .markers
        .iter()
        .filter(|m| m.kind == BridgeMarkerKind::Keep)
        .collect();
    if kept.is_empty() {
        return String::new();
    }
    let (start, end) = (indexed.to_byte(record.start), indexed.to_byte(record.end));
    if trim(&record.text).is_empty() {
        return xml[start..end].to_owned();
    }
    let source = &xml[start..end];
    let open = js_regex!(r"^<[^>]*>")
        .exec(source)
        .map_or("", |m| m.as_str());
    let element = match record.element {
        BridgeParagraphElement::TextP => "text:p",
        BridgeParagraphElement::TextH => "text:h",
    };
    let tag = js_regex!(r"^<([^\s/>]+)")
        .exec(open)
        .and_then(|m| m.get(1))
        .unwrap_or(element);
    let objects: String = kept
        .iter()
        .map(|m| &xml[indexed.to_byte(m.start)..indexed.to_byte(m.end)])
        .collect();
    format!("{open}{objects}</{tag}>")
}

/// `regionInner`: the inner XML of a region as it is now.
pub fn region_inner(rctx: &OoxmlToOdfContext, region: &OdtMasterPageRegion) -> String {
    if region.self_closing {
        String::new()
    } else {
        rctx.part(OdtStylePart::StylesXml).xml.text[region.open_end..region.close_start].to_owned()
    }
}

// ---------------------------------------------------------------------------
// Page number fields

/// The per-paragraph counters of `fieldCounters`: field element name to the
/// number of fields of that name written so far.
#[derive(Default)]
struct FieldCounters(HashMap<&'static str, usize>);

/// `pageFieldRunWriter`: writes the page number / page count runs of edited
/// header paragraphs.
pub struct PageFieldRunWriter;

impl RunWriter for PageFieldRunWriter {
    fn id(&self) -> &str {
        PAGE_OWNER
    }

    fn matches(&self, run: &Run) -> bool {
        let text = run.text.as_deref();
        text == Some(PAGE_MARK.to_string().as_str())
            || text == Some(TOTAL_PAGES_MARK.to_string().as_str())
    }

    fn to_odf(
        &self,
        rctx: &mut OoxmlToOdfContext,
        run: &Run,
        env: &ParagraphWriteEnv<'_>,
    ) -> Result<String, OdtError> {
        let name: &'static str = if run.text.as_deref() == Some(PAGE_MARK.to_string().as_str()) {
            "text:page-number"
        } else {
            "text:page-count"
        };
        let rank = {
            let mut counters = env.scratch.state::<FieldCounters>();
            let slot = counters.0.entry(name).or_insert(0);
            let rank = *slot;
            *slot += 1;
            rank
        };
        let own = env.origin.as_ref().map(|origin| {
            origin
                .markers
                .iter()
                .filter(|m| {
                    m.kind == BridgeMarkerKind::Handler
                        && m.owner.as_deref() == Some(PAGE_OWNER)
                        && m.name == name
                })
                .collect::<Vec<_>>()
        });
        if let (Some(own), Some(origin)) = (own, env.origin.as_ref()) {
            if let Some(original) = own.get(rank) {
                let info = rctx.part(origin.part);
                return Ok(info.xml.text
                    [info.xml.to_byte(original.start)..info.xml.to_byte(original.end)]
                    .to_owned());
            }
        }
        Ok(if name == "text:page-number" {
            "<text:page-number text:select-page=\"current\">1</text:page-number>".to_owned()
        } else {
            "<text:page-count>1</text:page-count>".to_owned()
        })
    }
}
