//! Element insertion (packages/pptx-engine/src/insert.ts): synthesizes raw
//! `<p:sp>`, `<p:cxnSp>`, `<p:graphicFrame>`, `<p:pic>` and `<p:grpSp>`
//! fragments and hangs them on `slide.elements`.
//!
//! Host inputs the TypeScript draws from the environment are arguments here:
//! `uuid` is what `crypto.randomUUID()` gives `creationIdXml`, `now_ms` is
//! `Date.now()`. `insertCounter` is a process-wide counter, as in the
//! TypeScript module.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use jscompat::{
    JsNum, JsObject, Radix, Slot, js_regex, math_max, math_min, math_round, number_to_string,
    parse_int, slice_utf16, to_number,
};
use serde::{Deserialize, Serialize};

use crate::animation::{c_nv_pr_ids_in_xml, prune_timing_for_spids};
use crate::deck::OpenedPptx;
use crate::generate::{clamp_pos_emu, generate_paragraph_xml, generate_xfrm_xml};
use crate::resource_cleanup::cleanup_deleted_element_resources;
use crate::types::{
    ArrowEnd, Autofit, ByteAnchor, ElementType, EmuRect, Fill, Insets, Paragraph, PictureElement,
    Slide, SlideElement, Stroke, TextBody, TextElement, TextRun, Transform,
};
use crate::with_element;
use crate::xml_utils::{
    creation_id_xml, escape_xml_attr, has_default_for, max_relationship_id_number,
};
use crate::zip::rels_path_for;

/// `NewShapeKind`: `textbox`, or an OOXML preset geometry name.
pub type NewShapeKind = String;

/// `wrap` of `NewElementBodyPr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyWrap {
    Square,
    None,
}

/// `anchor` of a body or a table cell: `t`, `ctr` or `b`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum CellAnchor {
    #[serde(rename = "t")]
    T,
    #[serde(rename = "ctr")]
    Ctr,
    #[serde(rename = "b")]
    B,
}

impl CellAnchor {
    fn as_str(self) -> &'static str {
        match self {
            Self::T => "t",
            Self::Ctr => "ctr",
            Self::B => "b",
        }
    }
}

/// `autoFit` of `NewElementBodyPr`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyAutoFit {
    Shrink,
    Resize,
}

/// `NewElementBodyPr`
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewElementBodyPr {
    pub wrap: Option<BodyWrap>,
    pub anchor: Option<CellAnchor>,
    pub insets_emu: Option<Insets>,
    pub auto_fit: Option<BodyAutoFit>,
}

/// `stroke` of `NewElementOptions`: `{ color, widthEmu }`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewStroke {
    pub color: String,
    pub width_emu: JsNum,
}

/// `NewElementOptions`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewElementOptions {
    pub kind: NewShapeKind,
    pub offset: EmuRect,
    #[serde(default)]
    pub paragraphs: Option<Vec<Paragraph>>,
    #[serde(default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub stroke: Option<NewStroke>,
    #[serde(default)]
    pub body_pr: Option<NewElementBodyPr>,
    #[serde(default)]
    pub adjustments: Option<JsObject<JsNum>>,
    #[serde(default)]
    pub flip_h: Option<bool>,
    #[serde(default)]
    pub flip_v: Option<bool>,
}

fn num(x: f64) -> String {
    number_to_string(x)
}

/// `x.toString(36)` for a non-negative integer (a counter, `Date.now()`).
fn to_string_radix36(x: f64) -> String {
    if !x.is_finite() || x < 0.0 || x.fract() != 0.0 || x >= 18_446_744_073_709_551_616.0 {
        return number_to_string(x);
    }
    let mut value = x as u64;
    if value == 0 {
        return "0".to_owned();
    }
    let mut digits: Vec<u8> = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        digits.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// `(color.replace(/^#/, '')).toUpperCase()`
fn strip_hash_upper(color: &str) -> String {
    color.strip_prefix('#').unwrap_or(color).to_uppercase()
}

/// `color.replace(/^#/, '').slice(0, 6).toUpperCase()`
fn hex6_upper(color: &str) -> String {
    let stripped = color.strip_prefix('#').unwrap_or(color);
    slice_utf16(stripped, 0.0, Some(6.0)).to_uppercase()
}

/// `#RRGGBB` or `#RRGGBBAA` as `<a:srgbClr>`, translucency as an `<a:alpha>` child.
fn srgb_clr_xml(color: &str) -> String {
    let hex = strip_hash_upper(color);
    let rgb = slice_utf16(&hex, 0.0, Some(6.0));
    if hex.encode_utf16().count() >= 8 {
        let alpha = math_round(
            parse_int(&slice_utf16(&hex, 6.0, Some(8.0)), Radix::Sixteen) / 255.0 * 100000.0,
        );
        if alpha < 100000.0 {
            return format!(
                "<a:srgbClr val=\"{rgb}\"><a:alpha val=\"{}\"/></a:srgbClr>",
                num(alpha)
            );
        }
    }
    format!("<a:srgbClr val=\"{rgb}\"/>")
}

/// A text box defaults to spAutoFit; preset shapes keep "do not autofit".
fn effective_auto_fit(body_pr: Option<&NewElementBodyPr>, is_textbox: bool) -> Option<BodyAutoFit> {
    body_pr
        .and_then(|b| b.auto_fit)
        .or(is_textbox.then_some(BodyAutoFit::Resize))
}

/// `<a:bodyPr>` for generated sp fragments.
fn build_body_pr_xml(body_pr: Option<&NewElementBodyPr>, is_textbox: bool) -> String {
    let wrap = match body_pr.and_then(|b| b.wrap) {
        Some(BodyWrap::None) => "none",
        _ => "square",
    };
    let mut attrs = format!("<a:bodyPr wrap=\"{wrap}\" rtlCol=\"0\"");
    if let Some(ins) = body_pr.and_then(|b| b.insets_emu.as_ref()) {
        attrs.push_str(&format!(
            " lIns=\"{}\" tIns=\"{}\" rIns=\"{}\" bIns=\"{}\"",
            num(math_round(ins.l.0)),
            num(math_round(ins.t.0)),
            num(math_round(ins.r.0)),
            num(math_round(ins.b.0))
        ));
    }
    if let Some(anchor) = body_pr.and_then(|b| b.anchor) {
        attrs.push_str(&format!(" anchor=\"{}\"", anchor.as_str()));
    }
    match effective_auto_fit(body_pr, is_textbox) {
        None => attrs + "/>",
        Some(BodyAutoFit::Shrink) => attrs + "><a:normAutofit/></a:bodyPr>",
        Some(BodyAutoFit::Resize) => attrs + "><a:spAutoFit/></a:bodyPr>",
    }
}

fn build_av_lst_xml(adjustments: Option<&JsObject<JsNum>>) -> String {
    let Some(adjustments) = adjustments else {
        return "<a:avLst/>".to_owned();
    };
    let mut out = String::from("<a:avLst>");
    for (name, value) in adjustments.entries() {
        out.push_str(&format!(
            "<a:gd name=\"{}\" fmla=\"val {}\"/>",
            escape_xml_attr(name),
            num(math_round(value.0))
        ));
    }
    out.push_str("</a:avLst>");
    out
}

/// `insertCounter`
static INSERT_COUNTER: AtomicU64 = AtomicU64::new(1);

/// `${prefix}_${(insertCounter++).toString(36)}_${Date.now().toString(36)}`
fn new_element_id(prefix: &str, now_ms: f64) -> String {
    let counter = INSERT_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{}_{}",
        to_string_radix36(counter as f64),
        to_string_radix36(now_ms)
    )
}

// ── Line / connector insertion ─────────────────────────────

/// One entry of `LINE_KINDS`.
#[derive(Debug, Clone, Copy)]
struct LineKind {
    prst: &'static str,
    head: bool,
    tail: bool,
}

/// `LINE_KINDS[kind]` for an own key only (the TypeScript's plain-object
/// lookup also answers inherited names, see the ledger note of `add_element`).
fn line_kind(kind: &str) -> Option<LineKind> {
    let (prst, head, tail) = match kind {
        "line" => ("line", false, false),
        "lineArrow" => ("straightConnector1", false, true),
        "lineArrowDouble" => ("straightConnector1", true, true),
        "lineBent" => ("bentConnector3", false, false),
        "lineCurved" => ("curvedConnector3", false, false),
        _ => return None,
    };
    Some(LineKind { prst, head, tail })
}

pub fn is_line_kind(kind: &str) -> bool {
    line_kind(kind).is_some()
}

fn default_line_stroke() -> NewStroke {
    NewStroke {
        color: "#000000".to_owned(),
        width_emu: JsNum(12700.0),
    }
}

fn plain_transform(offset: EmuRect, flip_h: bool, flip_v: bool) -> Transform {
    Transform {
        offset,
        rot: JsNum(0.0),
        flip_h,
        flip_v,
    }
}

fn build_cxn_sp_xml(slide: &Slide, opts: &NewElementOptions, def: LineKind, uuid: &str) -> String {
    let id = next_c_nv_pr_id(slide);
    let kind_name = if def.prst.starts_with("bentConnector") {
        "Elbow Connector"
    } else if def.prst.starts_with("curvedConnector") {
        "Curved Connector"
    } else {
        "Straight Connector"
    };
    let name = format!("{kind_name} {}", num(id));
    let stroke = opts.stroke.clone().unwrap_or_else(default_line_stroke);
    let color = hex6_upper(&stroke.color);
    let head = if def.head {
        "<a:headEnd type=\"triangle\" w=\"med\" len=\"med\"/>"
    } else {
        ""
    };
    let tail = if def.tail {
        "<a:tailEnd type=\"triangle\" w=\"med\" len=\"med\"/>"
    } else {
        ""
    };
    let xfrm = generate_xfrm_xml(
        &plain_transform(
            opts.offset,
            opts.flip_h == Some(true),
            opts.flip_v == Some(true),
        ),
        "a:xfrm",
    );
    format!(
        "<p:cxnSp><p:nvCxnSpPr><p:cNvPr id=\"{id}\" name=\"{name}\">{creation}</p:cNvPr>\
         <p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>\
         <p:spPr>{xfrm}<a:prstGeom prst=\"{prst}\">{av}</a:prstGeom>\
         <a:ln w=\"{w}\" cap=\"flat\">\
         <a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill>{head}{tail}</a:ln>\
         </p:spPr></p:cxnSp>",
        id = num(id),
        name = escape_xml_attr(&name),
        creation = creation_id_xml(uuid),
        prst = def.prst,
        av = build_av_lst_xml(opts.adjustments.as_ref()),
        w = num(math_round(stroke.width_emu.0)),
    )
}

/// `slide.originalXml`; '' where the slide has none.
fn slide_original_xml(slide: &Slide) -> &str {
    slide.original_xml.as_deref().unwrap_or("")
}

/// The elements of a slide; empty where it has none.
fn slide_elements(slide: &Slide) -> &[SlideElement] {
    slide.elements.as_deref().unwrap_or(&[])
}

/// Max cNvPr id used in the slide (including new elements); new elements take max+1.
pub fn next_c_nv_pr_id(slide: &Slide) -> f64 {
    let mut max = 1.0;
    let re = js_regex!(r#"<p:cNvPr\s[^>]*\bid=["'](\d+)["']"#);
    let mut scan = |xml: &str| {
        for found in re.find_iter(xml) {
            max = math_max(max, to_number(found.get(1).unwrap_or_default()));
        }
    };
    scan(slide_original_xml(slide));
    for el in slide_elements(slide) {
        scan(element_original_xml(el));
    }
    max + 1.0
}

/// `el.anchor.originalXml`
fn element_original_xml(el: &SlideElement) -> &str {
    with_element!(el, e => (*e.anchor).as_ref().map(|a| &*a.original_xml).unwrap_or(""))
}

pub fn build_sp_xml(slide: &Slide, opts: &NewElementOptions, uuid: &str) -> String {
    let id = next_c_nv_pr_id(slide);
    let is_textbox = opts.kind == "textbox";
    let name = if is_textbox {
        format!("TextBox {}", num(id))
    } else {
        format!("Shape {}", num(id))
    };
    let xfrm = generate_xfrm_xml(
        &plain_transform(
            opts.offset,
            opts.flip_h == Some(true),
            opts.flip_v == Some(true),
        ),
        "a:xfrm",
    );
    let geom = if is_textbox {
        "<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>".to_owned()
    } else {
        format!(
            "<a:prstGeom prst=\"{}\">{}</a:prstGeom>",
            escape_xml_attr(&opts.kind),
            build_av_lst_xml(opts.adjustments.as_ref())
        )
    };
    let fill = match opts.fill_color.as_deref().filter(|c| !c.is_empty()) {
        Some(color) => format!("<a:solidFill>{}</a:solidFill>", srgb_clr_xml(color)),
        None => String::new(),
    };
    let ln = match &opts.stroke {
        Some(stroke) => format!(
            "<a:ln w=\"{}\"><a:solidFill>{}</a:solidFill></a:ln>",
            num(math_round(stroke.width_emu.0)),
            srgb_clr_xml(&stroke.color)
        ),
        None => String::new(),
    };
    let paras: String = match opts.paragraphs.as_deref().filter(|p| !p.is_empty()) {
        Some(list) => list.iter().map(generate_paragraph_xml).collect(),
        None => generate_paragraph_xml(&empty_paragraph()),
    };
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\">{creation}</p:cNvPr>\
         <p:cNvSpPr{tx}/><p:nvPr/></p:nvSpPr>\
         <p:spPr>{xfrm}{geom}{fill}{ln}</p:spPr>\
         <p:txBody>{body}<a:lstStyle/>{paras}</p:txBody></p:sp>",
        id = num(id),
        name = escape_xml_attr(&name),
        creation = creation_id_xml(uuid),
        tx = if is_textbox { " txBox=\"1\"" } else { "" },
        body = build_body_pr_xml(opts.body_pr.as_ref(), is_textbox),
    )
}

/// `{ runs: [{ text: '' }] }`
fn empty_paragraph() -> Paragraph {
    Paragraph {
        runs: Slot::of(vec![TextRun {
            text: Slot::of(String::new()),
            ..TextRun::default()
        }]),
        ..Paragraph::default()
    }
}

/// The elements of a slide to push to.
fn elements_mut(slide: &mut Slide) -> Result<&mut Vec<SlideElement>, String> {
    slide
        .elements
        .as_mut()
        .ok_or_else(|| "the slide has no elements".to_owned())
}

/// Synthesize a new element and hang it on the slide; returns the model element.
///
/// Ledger `insert-inherited-line-kind`: the TypeScript reads
/// `LINE_KINDS[opts.kind]` from a plain object, so a kind named
/// `constructor`, `toString`, `__proto__` and the like finds an inherited
/// member, takes the line path and throws a TypeError. Here only the five own
/// kinds are lines; any other name is a preset geometry.
pub fn add_element(
    slide: &mut Slide,
    opts: &NewElementOptions,
    uuid: &str,
    now_ms: f64,
) -> Result<TextElement, String> {
    let sp_index = slide_elements(slide).len() as i64;
    if let Some(def) = line_kind(&opts.kind) {
        let stroke = opts.stroke.clone().unwrap_or_else(default_line_stroke);
        let xml = build_cxn_sp_xml(slide, opts, def, uuid);
        let el = TextElement {
            id: Slot::of(new_element_id("spnew", now_ms)),
            r#type: Slot::of(ElementType::Shape),
            anchor: Slot::of(ByteAnchor {
                sp_index,
                original_xml: Arc::from(xml),
                range: [0, 0],
                gap_after: None,
            }),
            transform: Slot::of(plain_transform(
                opts.offset,
                opts.flip_h == Some(true),
                opts.flip_v == Some(true),
            )),
            preset_geometry: Slot::of(def.prst.to_owned()),
            adjust: Slot::maybe(opts.adjustments.clone()),
            fill: Slot::of(Fill::None),
            stroke: Slot::of(Stroke {
                fill: Fill::Solid {
                    color: stroke.color.clone(),
                },
                width: JsNum(math_round(stroke.width_emu.0)),
                dash: None,
                cap: None,
                join: None,
                compound: None,
                head_end: def.head.then(|| ArrowEnd {
                    r#type: "triangle".to_owned(),
                    w: None,
                    len: None,
                }),
                tail_end: def.tail.then(|| ArrowEnd {
                    r#type: "triangle".to_owned(),
                    w: None,
                    len: None,
                }),
            }),
            ..TextElement::default()
        };
        elements_mut(slide)?.push(SlideElement::Text(Box::new(el.clone())));
        slide.structure_dirty.set(true);
        return Ok(el);
    }
    let xml = build_sp_xml(slide, opts, uuid);
    let is_textbox = opts.kind == "textbox";
    let auto_fit = effective_auto_fit(opts.body_pr.as_ref(), is_textbox);
    let paragraphs = match opts.paragraphs.as_ref().filter(|p| !p.is_empty()) {
        Some(list) => list.clone(),
        None => vec![empty_paragraph()],
    };
    let wrap_none = opts.body_pr.as_ref().and_then(|b| b.wrap) == Some(BodyWrap::None);
    let el = TextElement {
        id: Slot::of(new_element_id("spnew", now_ms)),
        r#type: Slot::of(if is_textbox {
            ElementType::Text
        } else {
            ElementType::Shape
        }),
        anchor: Slot::of(ByteAnchor {
            sp_index,
            original_xml: Arc::from(xml),
            range: [0, 0],
            gap_after: None,
        }),
        transform: Slot::of(plain_transform(
            opts.offset,
            opts.flip_h == Some(true),
            opts.flip_v == Some(true),
        )),
        preset_geometry: Slot::maybe((!is_textbox).then(|| opts.kind.clone())),
        adjust: Slot::maybe(if is_textbox {
            None
        } else {
            opts.adjustments.clone()
        }),
        fill: Slot::maybe(
            opts.fill_color
                .as_deref()
                .filter(|c| !c.is_empty())
                .map(|color| Fill::Solid {
                    color: color.to_owned(),
                }),
        ),
        stroke: Slot::maybe(opts.stroke.as_ref().map(|s| Stroke {
            fill: Fill::Solid {
                color: s.color.clone(),
            },
            width: JsNum(math_round(s.width_emu.0)),
            dash: None,
            cap: None,
            join: None,
            compound: None,
            head_end: None,
            tail_end: None,
        })),
        text: Slot::of(TextBody {
            paragraphs: Slot::of(paragraphs),
            autofit: Slot::maybe(auto_fit.map(|a| match a {
                BodyAutoFit::Shrink => Autofit::Shrink,
                BodyAutoFit::Resize => Autofit::Resize,
            })),
            wrap: Slot::maybe(wrap_none.then_some(false)),
            ..TextBody::default()
        }),
        ..TextElement::default()
    };
    elements_mut(slide)?.push(SlideElement::Text(Box::new(el.clone())));
    slide.structure_dirty.set(true);
    Ok(el)
}

// ── Table insertion (graphicFrame + a:tbl) ─────────────────────────────

/// `NewTableCellProps`
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableCellProps {
    pub grid_span: Option<JsNum>,
    pub row_span: Option<JsNum>,
    pub h_merge: Option<bool>,
    pub v_merge: Option<bool>,
    pub anchor: Option<CellAnchor>,
}

/// `NewTableOptions`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableOptions {
    pub rows: JsNum,
    pub cols: JsNum,
    pub offset: EmuRect,
    #[serde(default)]
    pub col_widths_emu: Option<Vec<JsNum>>,
    #[serde(default)]
    pub row_heights_emu: Option<Vec<JsNum>>,
    #[serde(default)]
    pub cell_props: Option<Vec<Vec<Option<NewTableCellProps>>>>,
}

/// PowerPoint's default style for new tables.
const DEFAULT_TABLE_STYLE_ID: &str = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

/// Largest row/column count an inserted table may have.
pub const MAX_INSERT_TABLE_DIM: f64 = 75.0;

/// Finite integer clamp with a safe fallback (NaN/Infinity land on `fallback`).
fn clamp_int(v: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if !v.is_finite() {
        return fallback;
    }
    math_min(math_max(min, v.floor()), max)
}

fn grid_emu(v: f64) -> f64 {
    math_max(1.0, math_round(clamp_pos_emu(v)))
}

/// Build the table graphicFrame fragment (equal-width columns / equal-height rows).
pub fn build_table_xml(slide: &Slide, opts: &NewTableOptions, uuid: &str) -> String {
    let id = next_c_nv_pr_id(slide);
    let rows = clamp_int(opts.rows.0, 1.0, MAX_INSERT_TABLE_DIM, 1.0);
    let cols = clamp_int(opts.cols.0, 1.0, MAX_INSERT_TABLE_DIM, 1.0);
    let col_w = grid_emu((clamp_pos_emu(opts.offset.cx.0) / cols).floor());
    let row_h = grid_emu((clamp_pos_emu(opts.offset.cy.0) / rows).floor());
    let col_ws: Vec<f64> = match opts.col_widths_emu.as_deref() {
        Some(list) if list.len() as f64 == cols => list.iter().map(|w| grid_emu(w.0)).collect(),
        _ => vec![col_w; cols as usize],
    };
    let row_hs: Vec<f64> = match opts.row_heights_emu.as_deref() {
        Some(list) if list.len() as f64 == rows => list.iter().map(|h| grid_emu(h.0)).collect(),
        _ => vec![row_h; rows as usize],
    };
    let grid: String = col_ws
        .iter()
        .map(|w| format!("<a:gridCol w=\"{}\"/>", num(*w)))
        .collect();
    let cell_xml = |r: usize, c: usize| -> String {
        let p = opts
            .cell_props
            .as_ref()
            .and_then(|rows| rows.get(r))
            .and_then(|row| row.get(c))
            .and_then(|cell| cell.as_ref());
        let mut attrs: Vec<String> = Vec::new();
        let grid_span = match p.and_then(|p| p.grid_span) {
            Some(span) => clamp_int(span.0, 1.0, cols - c as f64, 1.0),
            None => 1.0,
        };
        let row_span = match p.and_then(|p| p.row_span) {
            Some(span) => clamp_int(span.0, 1.0, rows - r as f64, 1.0),
            None => 1.0,
        };
        if grid_span > 1.0 {
            attrs.push(format!("gridSpan=\"{}\"", num(grid_span)));
        }
        if row_span > 1.0 {
            attrs.push(format!("rowSpan=\"{}\"", num(row_span)));
        }
        if p.and_then(|p| p.h_merge) == Some(true) {
            attrs.push("hMerge=\"1\"".to_owned());
        }
        if p.and_then(|p| p.v_merge) == Some(true) {
            attrs.push("vMerge=\"1\"".to_owned());
        }
        let tc_pr = match p.and_then(|p| p.anchor) {
            Some(anchor) if anchor != CellAnchor::T => {
                format!("<a:tcPr anchor=\"{}\"/>", anchor.as_str())
            }
            _ => "<a:tcPr/>".to_owned(),
        };
        let attr_text = if attrs.is_empty() {
            String::new()
        } else {
            format!(" {}", attrs.join(" "))
        };
        format!(
            "<a:tc{attr_text}><a:txBody><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>{tc_pr}</a:tc>"
        )
    };
    let mut trs = String::new();
    for (r, h) in row_hs.iter().enumerate() {
        trs.push_str(&format!("<a:tr h=\"{}\">", num(*h)));
        for c in 0..(cols as usize) {
            trs.push_str(&cell_xml(r, c));
        }
        trs.push_str("</a:tr>");
    }
    format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"Table {id}\">{creation}</p:cNvPr>\
         <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>\
         {xfrm}\
         <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\">\
         <a:tbl><a:tblPr firstRow=\"1\" bandRow=\"1\"><a:tableStyleId>{style}</a:tableStyleId></a:tblPr>\
         <a:tblGrid>{grid}</a:tblGrid>{trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
        id = num(id),
        creation = creation_id_xml(uuid),
        xfrm = generate_xfrm_xml(&plain_transform(opts.offset, false, false), "p:xfrm"),
        style = DEFAULT_TABLE_STYLE_ID,
    )
}

// ── Grid table insertion: explicit widths/heights/merges ──

/// `marginsEmu` of a cell: `{ l, t, r, b }`.
pub type CellMargins = Insets;

/// `NewTableCellSpec`
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableCellSpec {
    #[serde(default)]
    pub paragraphs: Option<Vec<Paragraph>>,
    #[serde(default)]
    pub grid_span: Option<JsNum>,
    #[serde(default)]
    pub row_span: Option<JsNum>,
    #[serde(default)]
    pub h_merge: Option<bool>,
    #[serde(default)]
    pub v_merge: Option<bool>,
    #[serde(default)]
    pub fill_color: Option<String>,
    #[serde(default)]
    pub anchor: Option<CellAnchor>,
    #[serde(default)]
    pub margins_emu: Option<CellMargins>,
}

/// `scope` of a grid table border.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum BorderScope {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "insideV")]
    InsideV,
}

/// `border` of `NewTableGridOptions`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableBorder {
    pub color: String,
    pub width_emu: JsNum,
    #[serde(default)]
    pub scope: Option<BorderScope>,
}

/// `NewTableGridOptions`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableGridOptions {
    pub offset: EmuRect,
    pub col_widths_emu: Vec<JsNum>,
    pub row_heights_emu: Vec<JsNum>,
    pub cells: Vec<Vec<NewTableCellSpec>>,
    #[serde(default)]
    pub border: Option<NewTableBorder>,
}

fn table_cell_xml(
    cell: &NewTableCellSpec,
    col_idx: f64,
    border: Option<&NewTableBorder>,
    max_grid_span: f64,
    max_row_span: f64,
) -> String {
    let mut attrs: Vec<String> = Vec::new();
    let grid_span = match cell.grid_span {
        Some(span) => clamp_int(span.0, 1.0, max_grid_span, 1.0),
        None => 1.0,
    };
    let row_span = match cell.row_span {
        Some(span) => clamp_int(span.0, 1.0, max_row_span, 1.0),
        None => 1.0,
    };
    if grid_span > 1.0 {
        attrs.push(format!("gridSpan=\"{}\"", num(grid_span)));
    }
    if row_span > 1.0 {
        attrs.push(format!("rowSpan=\"{}\"", num(row_span)));
    }
    if cell.h_merge == Some(true) {
        attrs.push("hMerge=\"1\"".to_owned());
    }
    if cell.v_merge == Some(true) {
        attrs.push("vMerge=\"1\"".to_owned());
    }
    let tc_attrs = if attrs.is_empty() {
        String::new()
    } else {
        format!(" {}", attrs.join(" "))
    };

    let mut tc_pr_attrs: Vec<String> = Vec::new();
    if let Some(m) = &cell.margins_emu {
        tc_pr_attrs.push(format!("marL=\"{}\"", num(math_round(m.l.0))));
        tc_pr_attrs.push(format!("marR=\"{}\"", num(math_round(m.r.0))));
        tc_pr_attrs.push(format!("marT=\"{}\"", num(math_round(m.t.0))));
        tc_pr_attrs.push(format!("marB=\"{}\"", num(math_round(m.b.0))));
    }
    if let Some(anchor) = cell.anchor.filter(|a| *a != CellAnchor::T) {
        tc_pr_attrs.push(format!("anchor=\"{}\"", anchor.as_str()));
    }

    // CT_TableCellProperties child order: lnL lnR lnT lnB ... fill
    let mut lines = String::new();
    if let Some(border) = border {
        let color = hex6_upper(&border.color);
        let w = num(math_max(1.0, math_round(border.width_emu.0)));
        let ln = |tag: &str| {
            format!(
                "<a:{tag} w=\"{w}\" cap=\"flat\"><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill></a:{tag}>"
            )
        };
        if border.scope.unwrap_or(BorderScope::All) == BorderScope::All {
            lines = ln("lnL") + &ln("lnR") + &ln("lnT") + &ln("lnB");
        } else if col_idx > 0.0 && cell.h_merge != Some(true) {
            // insideV: only the left edge of non-first columns carries the rule
            lines = ln("lnL");
        }
    }
    let fill = match cell.fill_color.as_deref().filter(|c| !c.is_empty()) {
        Some(color) => format!(
            "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
            hex6_upper(color)
        ),
        None => String::new(),
    };
    let inner = format!("{lines}{fill}");
    let attr_text = if tc_pr_attrs.is_empty() {
        String::new()
    } else {
        format!(" {}", tc_pr_attrs.join(" "))
    };
    let tc_pr = if inner.is_empty() {
        format!("<a:tcPr{attr_text}/>")
    } else {
        format!("<a:tcPr{attr_text}>{inner}</a:tcPr>")
    };

    let paras: String = match cell.paragraphs.as_deref().filter(|p| !p.is_empty()) {
        Some(list) => list.iter().map(generate_paragraph_xml).collect(),
        None => generate_paragraph_xml(&empty_paragraph()),
    };
    format!("<a:tc{tc_attrs}><a:txBody><a:bodyPr/><a:lstStyle/>{paras}</a:txBody>{tc_pr}</a:tc>")
}

/// Build a table graphicFrame with explicit column widths, row heights, merged
/// cells, per-cell shading/anchor/margins and uniform borders.
pub fn build_table_grid_xml(slide: &Slide, opts: &NewTableGridOptions, uuid: &str) -> String {
    let id = next_c_nv_pr_id(slide);
    let cols = opts.col_widths_emu.len() as f64;
    let grid: String = opts
        .col_widths_emu
        .iter()
        .map(|w| {
            format!(
                "<a:gridCol w=\"{}\"/>",
                num(math_max(1.0, math_round(clamp_pos_emu(w.0))))
            )
        })
        .collect();
    let mut trs = String::new();
    for (r, row) in opts.cells.iter().enumerate() {
        let height = opts.row_heights_emu.get(r).map_or(1.0, |h| h.0);
        let h = math_max(1.0, math_round(clamp_pos_emu(height)));
        trs.push_str(&format!("<a:tr h=\"{}\">", num(h)));
        for (col_idx, cell) in row.iter().enumerate() {
            trs.push_str(&table_cell_xml(
                cell,
                col_idx as f64,
                opts.border.as_ref(),
                cols - col_idx as f64,
                opts.cells.len() as f64 - r as f64,
            ));
        }
        trs.push_str("</a:tr>");
    }
    format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"Table {id}\">{creation}</p:cNvPr>\
         <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp=\"1\"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>\
         {xfrm}\
         <a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\">\
         <a:tbl><a:tblPr/><a:tblGrid>{grid}</a:tblGrid>{trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
        id = num(id),
        creation = creation_id_xml(uuid),
        xfrm = generate_xfrm_xml(&plain_transform(opts.offset, false, false), "p:xfrm"),
    )
}

// ── Picture insertion (media part surgery) ─────────────────────────────

/// `ownValue(IMAGE_MIME, ext)`: the table answers its own extensions only.
fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "tif" | "tiff" => "image/tiff",
        _ => return None,
    })
}

const IMAGE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/// `NewPictureOptions`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPictureOptions {
    #[serde(deserialize_with = "crate::json_bytes::bytes")]
    pub bytes: Vec<u8>,
    pub ext: String,
    pub offset: EmuRect,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub descr: Option<String>,
}

/// `{ rid, mediaPath }` of `addImageMediaAndRel`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMediaRel {
    pub rid: String,
    pub media_path: String,
}

/// Land an image into the package: media part + Content_Types Default + slide
/// rels. `None` for an extension that is no image type.
pub fn add_image_media_and_rel(
    opened: &mut OpenedPptx,
    slide_index: usize,
    bytes: &[u8],
    ext_raw: &str,
) -> Result<Option<ImageMediaRel>, String> {
    let slide_path = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Err("the slide does not exist".to_owned());
        };
        slide.path.as_deref().unwrap_or("").to_owned()
    };
    let archive = &mut opened.archive;
    let ext = ext_raw.to_lowercase();
    let Some(mime) = image_mime(&ext) else {
        return Ok(None);
    };

    // 1) media part: identical bytes already in the package share the part;
    // otherwise number = current max + 1
    let mut max_num = 0.0;
    let mut media_path: Option<String> = None;
    let suffix = format!(".{ext}");
    let media_re = js_regex!(r"^ppt\/media\/image(\d+)\.");
    for (path, existing) in archive.entries().iter() {
        let Some(found) = media_re.exec(path) else {
            continue;
        };
        max_num = math_max(max_num, to_number(found.get(1).unwrap_or_default()));
        if media_path.is_none() && path.ends_with(&suffix) && existing.as_slice() == bytes {
            media_path = Some(path.to_owned());
        }
    }
    let media_path = match media_path {
        Some(path) => path,
        None => {
            let path = format!("ppt/media/image{}.{ext}", num(max_num + 1.0));
            archive.entries_mut().set(path.clone(), bytes.to_vec());
            path
        }
    };

    // 2) [Content_Types] Default (added the first time this extension appears)
    let ct_path = "[Content_Types].xml";
    let content_types = archive
        .read_text(ct_path)
        .map(|text| text.into_owned())
        .filter(|text| !text.is_empty());
    if let Some(ct) = content_types
        && !has_default_for(&ct, &ext)
    {
        let dflt = format!("<Default Extension=\"{ext}\" ContentType=\"{mime}\"/>");
        let next = ct.replacen("</Types>", &format!("{dflt}</Types>"), 1);
        archive.entries_mut().set(ct_path, next.into_bytes());
    }

    // 3) slide rels: new rId (the rels file may not exist)
    let rels_path = rels_path_for(&slide_path);
    let rels = match archive.read_text(&rels_path) {
        Some(text) => text.into_owned(),
        None => "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned(),
    };
    let max_rid = max_relationship_id_number(&rels);
    let rid = format!("rId{}", num(max_rid + 1.0));
    let rel_xml = format!(
        "<Relationship Id=\"{rid}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"../media/{}\"/>",
        slice_utf16(&media_path, 10.0, None)
    );
    let next = rels.replacen("</Relationships>", &format!("{rel_xml}</Relationships>"), 1);
    archive.entries_mut().set(rels_path, next.into_bytes());
    Ok(Some(ImageMediaRel { rid, media_path }))
}

/// Insert a picture: media bytes into the package + [Content_Types] Default +
/// slide rels registration + synthesized `<p:pic>` fragment hung on the slide.
pub fn add_picture(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewPictureOptions,
    uuid: &str,
    now_ms: f64,
) -> Result<Option<PictureElement>, String> {
    let Some(added) = add_image_media_and_rel(opened, slide_index, &opts.bytes, &opts.ext)? else {
        return Ok(None);
    };
    let ImageMediaRel { rid, media_path } = added;

    // 4) <p:pic> fragment
    let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
        return Err("the slide does not exist".to_owned());
    };
    let id = next_c_nv_pr_id(slide);
    let name = match &opts.name {
        Some(name) => name.clone(),
        None => format!("Picture {}", num(id)),
    };
    let descr = opts.descr.as_deref().filter(|d| !d.is_empty());
    let descr_attr = match descr {
        Some(d) => format!(" descr=\"{}\"", escape_xml_attr(d)),
        None => String::new(),
    };
    let xml = format!(
        "<p:pic><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"{name}\"{descr_attr}>{creation}</p:cNvPr>\
         <p:cNvPicPr/><p:nvPr/></p:nvPicPr>\
         <p:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>\
         <p:spPr>{xfrm}\
         <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        id = num(id),
        name = escape_xml_attr(&name),
        creation = creation_id_xml(uuid),
        xfrm = generate_xfrm_xml(&plain_transform(opts.offset, false, false), "a:xfrm"),
    );
    let sp_index = slide_elements(slide).len() as i64;
    let el = PictureElement {
        id: Slot::of(new_element_id("picnew", now_ms)),
        r#type: Slot::of(ElementType::Picture),
        anchor: Slot::of(ByteAnchor {
            sp_index,
            original_xml: Arc::from(xml),
            range: [0, 0],
            gap_after: None,
        }),
        transform: Slot::of(plain_transform(opts.offset, false, false)),
        name: Slot::of(name),
        descr: Slot::maybe(descr.map(str::to_owned)),
        media_ref: Slot::of(media_path),
        ..PictureElement::default()
    };
    elements_mut(slide)?.push(SlideElement::Picture(Box::new(el.clone())));
    slide.structure_dirty.set(true);
    Ok(Some(el))
}

/// Delete by element id and collect relationships/resources no longer used by
/// any retained package part.
pub fn delete_element(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_id: &str,
) -> Result<bool, String> {
    let removed_xml = {
        let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
            return Err("the slide does not exist".to_owned());
        };
        let elements = elements_mut(slide)?;
        let Some(idx) = elements.iter().position(|e| e.id() == element_id) else {
            return Ok(false);
        };
        let removed = elements.remove(idx);
        let xml = element_original_xml(&removed).to_owned();
        slide.structure_dirty.set(true);
        xml
    };
    cleanup_deleted_element_resources(opened, slide_index, &removed_xml)?;
    // Animations targeting the removed shape (or its group children) would
    // otherwise keep dangling <p:spTgt spid> refs
    let ids: Vec<f64> = c_nv_pr_ids_in_xml(&removed_xml)
        .into_iter()
        .map(|id| id.0)
        .collect();
    let Some(slide) = opened.deck.slides.get_mut(slide_index) else {
        return Err("the slide does not exist".to_owned());
    };
    prune_timing_for_spids(slide, &ids)?;
    Ok(true)
}

// ── Grouping (p:grpSp) ──────────────────────────────────────────────────────

/// The axis-aligned bounding box of the offset rects of a set of elements.
pub fn calc_bounding_box<'a>(elements: impl IntoIterator<Item = &'a SlideElement>) -> EmuRect {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for el in elements {
        let Some(t) = with_element!(el, e => *e.transform) else {
            continue;
        };
        let o = t.offset;
        min_x = math_min(min_x, o.x.0);
        min_y = math_min(min_y, o.y.0);
        max_x = math_max(max_x, o.x.0 + o.cx.0);
        max_y = math_max(max_y, o.y.0 + o.cy.0);
    }
    EmuRect {
        x: JsNum(min_x),
        y: JsNum(min_y),
        cx: JsNum(max_x - min_x),
        cy: JsNum(max_y - min_y),
    }
}

/// Build the `<p:grpSp>` XML fragment (chOff == bbox.xy, chExt == bbox.cxcy).
pub fn build_grp_sp_xml(slide: &Slide, bbox: &EmuRect, children_xml: &str, uuid: &str) -> String {
    let id = next_c_nv_pr_id(slide);
    let name = format!("Group {}", num(id));
    let (x, y, cx, cy) = (num(bbox.x.0), num(bbox.y.0), num(bbox.cx.0), num(bbox.cy.0));
    let grp_xfrm = format!(
        "<a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/>\
         <a:chOff x=\"{x}\" y=\"{y}\"/><a:chExt cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>"
    );
    format!(
        "<p:grpSp><p:nvGrpSpPr><p:cNvPr id=\"{id}\" name=\"{name}\">{creation}</p:cNvPr>\
         <p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
         <p:grpSpPr>{grp_xfrm}</p:grpSpPr>{children_xml}</p:grpSp>",
        id = num(id),
        name = escape_xml_attr(&name),
        creation = creation_id_xml(uuid),
    )
}
