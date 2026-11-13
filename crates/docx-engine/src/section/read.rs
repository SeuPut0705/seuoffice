//! The read side of packages/docx-engine/src/section.ts: page setup, note
//! properties, line numbering, header/footer references, the section list and
//! the page colour.

use jscompat::{
    JsNum, JsObject, JsRegex, Radix, js_regex, math_round, parse_float, parse_int, truthy,
};
use serde::{Deserialize, Serialize};

use super::xml_flag_on;
use crate::vml::math_max;
use crate::xml_text::on_off_tag_in;

/// `strAttr(tag, name)` for a literal name: either quote style, the pattern
/// compiled once per call site.
macro_rules! str_attr {
    ($tag:expr, $name:literal) => {
        js_regex!(concat!($name, r#"\s*=\s*["']([^"']*)["']"#))
            .exec($tag)
            .and_then(|found| found.get(1))
    };
}

/// `intAttr(tag, name, fallback)` for a literal name.
macro_rules! int_attr {
    ($tag:expr, $name:literal, $fallback:expr) => {
        int_attr(
            $tag,
            js_regex!(concat!($name, r#"\s*=\s*["'](-?\d+(?:\.\d+)?)["']"#)),
            $fallback,
        )
    };
}

/// The first match of `pattern` in `xml`, or `""`: `pattern.exec(xml)?.[0] ?? ''`.
fn tag_in<'x>(xml: &'x str, pattern: &JsRegex) -> &'x str {
    pattern.exec(xml).map_or("", |found| found.as_str())
}

/// Integer attribute of a tag, either quote style. Fractional twips round like
/// the paragraph spacing/indent readers do instead of dropping to the default.
fn int_attr(tag: &str, pattern: &JsRegex, fallback: f64) -> f64 {
    let v = pattern
        .exec(tag)
        .and_then(|found| found.get(1))
        .map_or(f64::NAN, |digits| math_round(parse_float(digits)));
    if v.is_finite() { v } else { fallback }
}

/// Page setup from one w:sectPr XML slice. All lengths in twips.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSettings {
    pub page_width: JsNum,
    pub page_height: JsNum,
    pub orientation: &'static str,
    pub margin_top: JsNum,
    pub margin_right: JsNum,
    pub margin_bottom: JsNum,
    pub margin_left: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin_top_fixed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin_bottom_fixed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gutter: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gutter_at_top: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header_dist: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footer_dist: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_align: Option<&'static str>,
    pub page_border: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_border_props: Option<PageBorderProps>,
    pub columns: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col_space: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub col_widths: Option<Vec<JsNum>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_numbers: Option<LineNumbering>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bidi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_grid: Option<DocGrid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footnote_pr: Option<NoteProps>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endnote_pr: Option<NoteProps>,
}

/// US Letter, portrait, 1-inch margins.
pub const DEFAULT_SECTION: SectionSettings = SectionSettings {
    page_width: JsNum(12240.0),
    page_height: JsNum(15840.0),
    orientation: "portrait",
    margin_top: JsNum(1440.0),
    margin_right: JsNum(1440.0),
    margin_bottom: JsNum(1440.0),
    margin_left: JsNum(1440.0),
    margin_top_fixed: None,
    margin_bottom_fixed: None,
    gutter: None,
    gutter_at_top: None,
    page_border: false,
    page_border_props: None,
    columns: JsNum(1.0),
    col_space: None,
    col_widths: None,
    line_numbers: None,
    bidi: None,
    header_dist: Some(JsNum(720.0)),
    footer_dist: Some(JsNum(720.0)),
    v_align: None,
    doc_grid: None,
    text_direction: None,
    footnote_pr: None,
    endnote_pr: None,
};

/// Page border box details of a visible w:pgBorders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBorderProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_order: Option<&'static str>,
    /// border distance in points (max across sides' w:space)
    pub space_pt: JsNum,
    /// line width in points (max across sides)
    pub width_pt: JsNum,
    /// hex without '#', first side declaring a literal colour
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Per-side lines (top, left, bottom, right) in the order the file sets
    /// them; a missing side draws no border.
    pub sides: JsObject<PageBorderSide>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBorderSide {
    /// OOXML line style or an art border name
    pub val: String,
    /// eighth-points / 8; art borders: the tiled pattern height in points
    pub width_pt: JsNum,
    pub space_pt: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame: Option<bool>,
}

/// Section line numbering (sectPr w:lnNumType).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineNumbering {
    pub count_by: JsNum,
    pub start: JsNum,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<JsNum>,
    pub restart: &'static str,
}

/// Document grid (w:docGrid).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocGrid {
    #[serde(rename = "type")]
    pub grid_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_pitch: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub char_space: Option<JsNum>,
}

/// w:footnotePr / w:endnotePr: the fields the element declares.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteProps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pos: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_fmt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_start: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_restart: Option<&'static str>,
}

/// The element `notePropsFromXml` reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum NotePrTag {
    #[serde(rename = "w:footnotePr")]
    Footnote,
    #[serde(rename = "w:endnotePr")]
    Endnote,
}

/// Header or footer references.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HfKind {
    Header,
    Footer,
}

/// One section: settings, start type, block ownership, header/footer refs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionInfo {
    pub settings: SectionSettings,
    pub start_type: &'static str,
    pub first_block_index: JsNum,
    pub last_block_index: JsNum,
    pub sect_pr_xml: String,
    pub title_pg: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number_start: Option<JsNum>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_number_fmt: Option<String>,
    /// Header reference rIds by variant (default, first, even), in the order
    /// the sectPr sets them.
    pub header_refs: JsObject<String>,
    pub footer_refs: JsObject<String>,
}

/// The fields of a body block the section readers look at.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionBlock {
    pub hidden: Option<bool>,
    pub original_xml: Option<String>,
    pub docx_index: Option<f64>,
}

/// Vertical alignment of page content (sectPr w:vAlign); top/default is `None`.
fn v_align_of(xml: &str) -> Option<&'static str> {
    match str_attr!(tag_in(xml, js_regex!(r"<w:vAlign[^>]*\/?>")), "w:val") {
        Some("center") => Some("center"),
        Some("both") => Some("both"),
        Some("bottom") => Some("bottom"),
        _ => None,
    }
}

fn pg_borders_of(xml: &str) -> Option<&str> {
    js_regex!(r"<w:pgBorders[^>]*\/>|<w:pgBorders[\s\S]*?<\/w:pgBorders>")
        .exec(xml)
        .map(|found| found.as_str())
}

fn border_sides_of(pg_borders: &str) -> impl Iterator<Item = &str> {
    js_regex!(r"<w:(?:top|left|bottom|right)\b[^>]*\/?>")
        .find_iter(pg_borders)
        .map(|found| found.as_str())
}

/// True when w:pgBorders declares at least one visible side. Word writes an
/// explicit "no border" as sides with w:val="none" (or "nil").
fn has_visible_page_border(xml: &str) -> bool {
    let Some(pg_borders) = truthy(pg_borders_of(xml)) else {
        return false;
    };
    border_sides_of(pg_borders)
        .any(|side| str_attr!(side, "w:val").is_some_and(|val| val != "none" && val != "nil"))
}

fn on_off_attr(value: Option<&str>) -> bool {
    matches!(value, Some("1" | "true" | "on"))
}

/// ST_Border line styles; every other w:val is an art (bitmap) border.
pub const LINE_BORDER_VALS: [&str; 25] = [
    "single",
    "thick",
    "double",
    "dotted",
    "dashed",
    "dotDash",
    "dotDotDash",
    "triple",
    "thinThickSmallGap",
    "thickThinSmallGap",
    "thinThickThinSmallGap",
    "thinThickMediumGap",
    "thickThinMediumGap",
    "thinThickThinMediumGap",
    "thinThickLargeGap",
    "thickThinLargeGap",
    "thinThickThinLargeGap",
    "wave",
    "doubleWave",
    "dashSmallGap",
    "dashDotStroked",
    "threeDEmboss",
    "threeDEngrave",
    "outset",
    "inset",
];

/// Styling details of a visible w:pgBorders box (`None` when no side shows).
fn page_border_props_of(xml: &str) -> Option<PageBorderProps> {
    let pg_borders = truthy(pg_borders_of(xml))?;
    if !has_visible_page_border(xml) {
        return None;
    }
    let display = str_attr!(pg_borders, "w:display");
    let offset_from = str_attr!(pg_borders, "w:offsetFrom");
    let z_order = js_regex!(r#"\bw:zOrder\s*=\s*["']back["']"#)
        .test(pg_borders)
        .then_some("back");
    let mut space_pt = 0.0;
    let mut width_pt = 0.0;
    let mut color: Option<&str> = None;
    let mut sides = JsObject::new();
    for side in border_sides_of(pg_borders) {
        let Some(val) = truthy(str_attr!(side, "w:val")) else {
            continue;
        };
        if val == "none" || val == "nil" {
            continue;
        }
        let Some(name) = js_regex!(r"<w:(top|left|bottom|right)\b")
            .exec(side)
            .and_then(|found| found.get(1))
        else {
            continue;
        };
        let side_color = js_regex!(r#"w:color\s*=\s*["']([0-9A-Fa-f]{6})["']"#)
            .exec(side)
            .and_then(|found| found.get(1));
        // art borders: w:sz is the tiled pattern height in points, not eighth-points
        let art = !LINE_BORDER_VALS.contains(&val);
        let sz = int_attr!(side, "w:sz", 0.0);
        let side_width = if art { sz } else { sz / 8.0 };
        sides.set(
            name,
            PageBorderSide {
                val: val.to_owned(),
                width_pt: JsNum(side_width),
                space_pt: JsNum(int_attr!(side, "w:space", 0.0)),
                color: truthy(side_color).map(str::to_owned),
                art: art.then_some(true),
                shadow: on_off_attr(str_attr!(side, "w:shadow")).then_some(true),
                frame: on_off_attr(str_attr!(side, "w:frame")).then_some(true),
            },
        );
        space_pt = math_max(space_pt, int_attr!(side, "w:space", 0.0));
        width_pt = math_max(width_pt, side_width);
        color = color.or(side_color);
    }
    Some(PageBorderProps {
        display: truthy(display).map(str::to_owned),
        offset_from: truthy(offset_from).map(str::to_owned),
        z_order,
        space_pt: JsNum(space_pt),
        width_pt: JsNum(width_pt),
        color: truthy(color).map(str::to_owned),
        sides,
    })
}

/// Page setup from one w:sectPr XML slice.
pub fn section_settings_from_xml(xml: &str, gutter_at_top: Option<bool>) -> SectionSettings {
    let pg_sz = tag_in(xml, js_regex!(r"<w:pgSz[^>]*\/?>"));
    let pg_mar = tag_in(xml, js_regex!(r"<w:pgMar[^>]*\/?>"));

    let doc_grid = truthy(
        js_regex!(r"<w:docGrid[^>]*\/?>")
            .exec(xml)
            .map(|found| found.as_str()),
    )
    .map(|doc_grid_tag| {
        let grid_type = str_attr!(doc_grid_tag, "w:type").unwrap_or("default");
        let line_pitch = int_attr!(doc_grid_tag, "w:linePitch", -1.0);
        let char_space = int_attr!(doc_grid_tag, "w:charSpace", f64::NAN);
        DocGrid {
            grid_type: match grid_type {
                "lines" => "lines",
                "linesAndChars" => "linesAndChars",
                "snapToChars" => "snapToChars",
                _ => "default",
            },
            line_pitch: (line_pitch >= 0.0).then_some(JsNum(line_pitch)),
            char_space: char_space.is_finite().then_some(JsNum(char_space)),
        }
    });

    // explicit unequal column widths (w:cols > w:col children); matching the
    // w:col start tag covers the self-closing and the paired spelling
    let col_widths: Vec<JsNum> = js_regex!(r"<w:cols[^>]*>[\s\S]*?<\/w:cols>")
        .exec(xml)
        .map(|cols| {
            js_regex!(r#"<w:col [^>]*w:w=["'][\d.]+["'][^>]*>"#)
                .find_iter(cols.as_str())
                .map(|tag| int_attr!(tag.as_str(), "w:w", 0.0))
                .filter(|w| *w > 0.0)
                .map(JsNum)
                .collect()
        })
        .unwrap_or_default();

    let page_border_props = page_border_props_of(xml);
    let footnote_pr = note_props_from_xml(xml, NotePrTag::Footnote);
    let endnote_pr = note_props_from_xml(xml, NotePrTag::Endnote);
    let line_numbers = line_numbering_of(xml);
    let margin_top = int_attr!(pg_mar, "w:top", DEFAULT_SECTION.margin_top.0);
    let margin_bottom = int_attr!(pg_mar, "w:bottom", DEFAULT_SECTION.margin_bottom.0);
    // Word widens the binding-side margin by the gutter (left, or top with
    // gutterAtTop; mirrored inside margins are not modelled)
    let gutter = math_max(0.0, int_attr!(pg_mar, "w:gutter", 0.0));
    let gutter_at_top = gutter > 0.0 && gutter_at_top == Some(true);
    let cols = tag_in(xml, js_regex!(r"<w:cols[^>]*\/?>"));

    SectionSettings {
        page_width: JsNum(int_attr!(pg_sz, "w:w", DEFAULT_SECTION.page_width.0)),
        page_height: JsNum(int_attr!(pg_sz, "w:h", DEFAULT_SECTION.page_height.0)),
        orientation: if str_attr!(pg_sz, "w:orient") == Some("landscape") {
            "landscape"
        } else {
            "portrait"
        },
        margin_top: JsNum(margin_top.abs() + if gutter_at_top { gutter } else { 0.0 }),
        margin_right: JsNum(int_attr!(pg_mar, "w:right", DEFAULT_SECTION.margin_right.0)),
        margin_bottom: JsNum(margin_bottom.abs()),
        margin_left: JsNum(
            int_attr!(pg_mar, "w:left", DEFAULT_SECTION.margin_left.0)
                + if gutter_at_top { 0.0 } else { gutter },
        ),
        margin_top_fixed: (margin_top < 0.0).then_some(true),
        margin_bottom_fixed: (margin_bottom < 0.0).then_some(true),
        gutter: (gutter > 0.0).then_some(JsNum(gutter)),
        gutter_at_top: gutter_at_top.then_some(true),
        header_dist: Some(JsNum(int_attr!(pg_mar, "w:header", 720.0))),
        footer_dist: Some(JsNum(int_attr!(pg_mar, "w:footer", 720.0))),
        v_align: v_align_of(xml),
        page_border: has_visible_page_border(xml),
        page_border_props,
        columns: JsNum(int_attr!(cols, "w:num", 1.0)),
        col_space: Some(JsNum(int_attr!(cols, "w:space", 720.0))),
        col_widths: (col_widths.len() >= 2).then_some(col_widths),
        line_numbers,
        bidi: matches!(on_off_tag_in(xml, "w:bidi"), Ok(Some(true))).then_some(true),
        doc_grid,
        text_direction: text_direction_of(xml),
        footnote_pr,
        endnote_pr,
    }
}

/// The fields declared by a w:footnotePr / w:endnotePr element (sectPr or
/// settings.xml); `None` when the element is absent or declares none of them.
pub fn note_props_from_xml(xml: &str, tag: NotePrTag) -> Option<NoteProps> {
    let element = match tag {
        NotePrTag::Footnote => js_regex!(r"<w:footnotePr>([\s\S]*?)</w:footnotePr>"),
        NotePrTag::Endnote => js_regex!(r"<w:endnotePr>([\s\S]*?)</w:endnotePr>"),
    };
    let el = truthy(element.exec(xml).and_then(|found| found.get(1)))?;
    let pos = str_attr!(tag_in(el, js_regex!(r"<w:pos\b[^>]*\/?>")), "w:val");
    let num_fmt = str_attr!(tag_in(el, js_regex!(r"<w:numFmt\b[^>]*\/?>")), "w:val");
    let num_start = str_attr!(tag_in(el, js_regex!(r"<w:numStart\b[^>]*\/?>")), "w:val");
    let num_restart = str_attr!(tag_in(el, js_regex!(r"<w:numRestart\b[^>]*\/?>")), "w:val");
    let out = NoteProps {
        pos: match pos {
            Some("pageBottom") => Some("pageBottom"),
            Some("beneathText") => Some("beneathText"),
            Some("sectEnd") => Some("sectEnd"),
            Some("docEnd") => Some("docEnd"),
            _ => None,
        },
        num_fmt: truthy(num_fmt).map(str::to_owned),
        num_start: truthy(num_start)
            .filter(|start| js_regex!(r"^\d+$").test(start))
            .map(|start| JsNum(parse_int(start, Radix::Ten))),
        num_restart: match num_restart {
            Some("continuous") => Some("continuous"),
            Some("eachSect") => Some("eachSect"),
            Some("eachPage") => Some("eachPage"),
            _ => None,
        },
    };
    let declared = out.pos.is_some()
        || out.num_fmt.is_some()
        || out.num_start.is_some()
        || out.num_restart.is_some();
    declared.then_some(out)
}

/// w:lnNumType of a sectPr slice; `None` when the section has no line numbering.
pub fn line_numbering_of(xml: &str) -> Option<LineNumbering> {
    let tag = truthy(
        js_regex!(r"<w:lnNumType\b[^>]*\/?>")
            .exec(xml)
            .map(|found| found.as_str()),
    )?;
    let distance = int_attr!(tag, "w:distance", -1.0);
    Some(LineNumbering {
        count_by: JsNum(math_max(1.0, int_attr!(tag, "w:countBy", 1.0))),
        // Word skips w:start lines before the first label and restarts per
        // page unless told otherwise
        start: JsNum(math_max(0.0, int_attr!(tag, "w:start", 0.0)) + 1.0),
        distance: (distance >= 0.0).then_some(JsNum(distance)),
        restart: match str_attr!(tag, "w:restart") {
            Some("continuous") => "continuous",
            Some("newSection") => "newSection",
            _ => "newPage",
        },
    })
}

fn text_direction_of(xml: &str) -> Option<String> {
    let val = str_attr!(
        tag_in(xml, js_regex!(r"<w:textDirection[^>]*\/?>")),
        "w:val"
    );
    truthy(val).filter(|val| *val != "lrTb").map(str::to_owned)
}

/// Page setup from the trailing (hidden) w:sectPr.
pub fn read_section_settings(
    blocks: &[SectionBlock],
    gutter_at_top: Option<bool>,
) -> SectionSettings {
    let sect_block = blocks.iter().find(|block| {
        block.hidden == Some(true)
            && block
                .original_xml
                .as_deref()
                .is_some_and(|xml| xml.contains("<w:sectPr"))
    });
    let xml = sect_block
        .and_then(|block| block.original_xml.as_deref())
        .unwrap_or("");
    section_settings_from_xml(xml, gutter_at_top)
}

/// Header/footer reference elements of a sectPr, in document order. Matching
/// is quote-agnostic and covers the empty element pair LibreOffice writes.
pub fn hf_reference_tags(xml: &str, kind: HfKind) -> Vec<&str> {
    let pattern = match kind {
        HfKind::Header => js_regex!(r"<w:headerReference\b[^>]*(?:\/>|>\s*<\/w:headerReference>)"),
        HfKind::Footer => js_regex!(r"<w:footerReference\b[^>]*(?:\/>|>\s*<\/w:footerReference>)"),
    };
    pattern.find_iter(xml).map(|found| found.as_str()).collect()
}

/// w:type of a header/footer reference element (`None` when undeclared).
pub fn hf_reference_type(tag: &str) -> Option<&str> {
    js_regex!(r#"\bw:type\s*=\s*["']([^"']*)["']"#)
        .exec(tag)
        .and_then(|found| found.get(1))
}

/// r:id of a header/footer reference element (`None` when undeclared).
pub fn hf_reference_r_id(tag: &str) -> Option<&str> {
    js_regex!(r#"\br:id\s*=\s*["']([^"']+)["']"#)
        .exec(tag)
        .and_then(|found| found.get(1))
}

fn hf_refs(xml: &str, kind: HfKind) -> JsObject<String> {
    let mut refs = JsObject::new();
    for reference in hf_reference_tags(xml, kind) {
        let variant = match hf_reference_type(reference) {
            Some("first") => "first",
            Some("even") => "even",
            _ => "default",
        };
        if let Some(r_id) = truthy(hf_reference_r_id(reference)) {
            refs.set(variant, r_id.to_owned());
        }
    }
    refs
}

pub fn section_from_sect_pr(
    sect_pr_xml: &str,
    first_block_index: f64,
    last_block_index: f64,
    gutter_at_top: Option<bool>,
) -> SectionInfo {
    let pg_num_tag = tag_in(sect_pr_xml, js_regex!(r"<w:pgNumType[^>]*\/?>"));
    let start_type = match str_attr!(tag_in(sect_pr_xml, js_regex!(r"<w:type[^>]*\/?>")), "w:val") {
        Some("continuous") => "continuous",
        Some("evenPage") => "evenPage",
        Some("oddPage") => "oddPage",
        Some("nextColumn") => "nextColumn",
        _ => "nextPage",
    };
    let pg_num_start = js_regex!(r#"w:start\s*=\s*["'](\d+)["']"#)
        .exec(pg_num_tag)
        .and_then(|found| found.get(1));
    let pg_num_fmt = js_regex!(r#"w:fmt\s*=\s*["']([^"']+)["']"#)
        .exec(pg_num_tag)
        .and_then(|found| found.get(1));
    SectionInfo {
        settings: section_settings_from_xml(sect_pr_xml, gutter_at_top),
        start_type,
        first_block_index: JsNum(first_block_index),
        last_block_index: JsNum(last_block_index),
        sect_pr_xml: sect_pr_xml.to_owned(),
        // the tag is a literal that compiles
        title_pg: xml_flag_on(sect_pr_xml, "w:titlePg").unwrap_or(false),
        page_number_start: pg_num_start.map(|start| JsNum(parse_int(start, Radix::Ten))),
        page_number_fmt: pg_num_fmt.map(str::to_owned),
        header_refs: hf_refs(sect_pr_xml, HfKind::Header),
        footer_refs: hf_refs(sect_pr_xml, HfKind::Footer),
    }
}

/// Every section in document order. A paragraph-level w:sectPr closes its
/// section; the trailing hidden sectPr closes the last. Block ranges use
/// docxIndex (body child order), boundaries inclusive.
pub fn read_sections(blocks: &[SectionBlock], gutter_at_top: Option<bool>) -> Vec<SectionInfo> {
    let mut sections = Vec::new();
    let mut first = 0.0;
    for block in blocks {
        let xml = block.original_xml.as_deref().unwrap_or("");
        let Some(docx_index) = block.docx_index else {
            continue;
        };
        if !xml.contains("<w:sectPr") {
            continue;
        }
        let sect_pr_xml = js_regex!(r"<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>")
            .exec(xml)
            .map(|found| found.as_str());
        let Some(sect_pr_xml) = truthy(sect_pr_xml) else {
            continue;
        };
        sections.push(section_from_sect_pr(
            sect_pr_xml,
            first,
            docx_index,
            gutter_at_top,
        ));
        first = docx_index + 1.0;
    }
    if sections.is_empty() {
        let last = blocks
            .last()
            .and_then(|block| block.docx_index)
            .unwrap_or(0.0);
        sections.push(section_from_sect_pr("", 0.0, last, None));
    }
    sections
}

/// The page colour (w:background) of document.xml; `None` (null) when unset.
pub fn read_page_color(document_xml: &str) -> Option<String> {
    js_regex!(r#"<w:background[^>]*w:color="([0-9A-Fa-f]{6})""#)
        .exec(document_xml)
        .and_then(|found| found.get(1))
        .map(str::to_ascii_uppercase)
}
