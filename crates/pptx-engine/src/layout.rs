//! SlideLayout listing and inserting a new slide with a given layout
//! (packages/pptx-engine/src/layout.ts).
//!
//! Read-only: layout parts are never written back.

use jscompat::{
    JsNum, Radix, js_regex, math_max, number_to_string, parse_int, slice_utf16, sort_by_number,
};
use serde::{Deserialize, Serialize};

use crate::slide_ids::{can_list_slide, with_slide_listed};
use crate::types::SlideDeck;
use crate::xml_utils::{
    c_sld_name_of, escape_xml_attr, has_content_type_override, max_relationship_id_number,
};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

// -- Layout placeholder summary -------------------------------------------------

/// Summary of one placeholder (used to generate empty placeholder elements for new slides)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutPlaceholder {
    /// ph type: 'title'|'ctrTitle'|'body'|'subTitle'|'obj'|'ftr'|'sldNum'|'dt'|''
    #[serde(rename = "type")]
    pub r#type: String,
    /// ph idx
    pub idx: String,
    /// Geometry (EMU; read directly from the layout)
    pub x: JsNum,
    pub y: JsNum,
    pub cx: JsNum,
    pub cy: JsNum,
    /// Editor default hint text (shown in the empty box)
    pub hint: String,
}

/// Description of one slideLayout
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideLayoutInfo {
    /// Path inside the zip, e.g. ppt/slideLayouts/slideLayout3.xml
    pub path: String,
    /// Layout name (<p:cSld name="...">, falling back to the file name)
    pub name: String,
    /// Layout type attribute (blank/title/titleBody/...; from <p:sldLayout type="...">)
    pub layout_type: String,
    /// Main placeholders (excluding functional placeholders ftr/sldNum/dt/pic)
    pub placeholders: Vec<LayoutPlaceholder>,
}

/// `PH_HINT_MAP`
pub const PH_HINT_MAP: [(&str, &str); 6] = [
    ("title", "Click to add title"),
    ("ctrTitle", "Click to add title"),
    ("body", "Click to add text"),
    ("subTitle", "Click to add subtitle"),
    ("obj", "Click to add content"),
    ("", "Click to add text"),
];

/// `FUNCTION_TYPES`
pub const FUNCTION_TYPES: [&str; 4] = ["ftr", "sldNum", "dt", "pic"];

/// The names a plain object inherits from `Object.prototype`: reading one of
/// them from a record by document text finds a function (or the prototype),
/// never `undefined`.
pub(crate) fn is_object_prototype_name(name: &str) -> bool {
    matches!(
        name,
        "constructor"
            | "__defineGetter__"
            | "__defineSetter__"
            | "hasOwnProperty"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toString"
            | "valueOf"
            | "__proto__"
            | "toLocaleString"
    )
}

/// `ownValue(PH_HINT_MAP, type) ?? 'Click to add text'`: the table answers its own types only.
pub fn hint_for(ph_type: &str) -> String {
    PH_HINT_MAP
        .iter()
        .find(|(key, _)| *key == ph_type)
        .map_or("Click to add text", |(_, hint)| hint)
        .to_owned()
}

/// `text.replace(needle, () => replacement)`: the first occurrence of a string
/// needle replaced by the text as given, no `$` pattern read.
pub(crate) fn replace_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => {
            let mut out = String::with_capacity(text.len() + replacement.len());
            out.push_str(text.get(..at).unwrap_or_default());
            out.push_str(replacement);
            out.push_str(text.get(at + needle.len()..).unwrap_or_default());
            out
        }
        None => text.to_owned(),
    }
}

/// The name the layout gives itself (`cSldNameOf`), or the fallback
fn parse_layout_name(xml: &str, fallback: &str) -> String {
    c_sld_name_of(xml)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

/// Quick-parse the <p:sldLayout> type attribute from the layout XML
fn parse_layout_type(xml: &str) -> String {
    js_regex!(r#"<p:sldLayout\b[^>]*\btype="([^"]*)""#)
        .exec(xml)
        .and_then(|found| found.get(1))
        .unwrap_or("custom")
        .to_owned()
}

/// Parse all placeholder geometry from the layout XML (only non-functional placeholders with an xfrm)
pub fn parse_layout_placeholders(xml: &str) -> Vec<LayoutPlaceholder> {
    let mut results = Vec::new();
    for sp_match in js_regex!(
        r"<p:sp>([\s\S]*?)<\/p:sp>|<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>|<p:pic>([\s\S]*?)<\/p:pic>",
        "g"
    )
    .find_iter(xml)
    {
        let Some(sp) = sp_match
            .get(1)
            .or_else(|| sp_match.get(2))
            .or_else(|| sp_match.get(3))
        else {
            continue;
        };
        let Some(ph_match) = js_regex!(r"<p:ph\b([^>]*)\/?>").exec(sp) else {
            continue;
        };
        let ph_attr = ph_match.get(1).unwrap_or_default();
        let ph_type = js_regex!(r#"\btype="([^"]*)""#)
            .exec(ph_attr)
            .and_then(|found| found.get(1))
            .unwrap_or_default();
        let idx = js_regex!(r#"\bidx="([^"]*)""#)
            .exec(ph_attr)
            .and_then(|found| found.get(1))
            .unwrap_or_default();
        if FUNCTION_TYPES.contains(&ph_type) {
            continue;
        }
        // Try to parse the xfrm (may come from the layout or the master)
        let Some(xfrm) = js_regex!(r"<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>")
            .exec(sp)
            .or_else(|| js_regex!(r"<p:xfrm\b[^>]*>([\s\S]*?)<\/p:xfrm>").exec(sp))
        else {
            continue;
        };
        let xfrm_content = xfrm.get(1).unwrap_or_default();
        let off = js_regex!(r"<a:off\b([^>]*)\/?")
            .exec(xfrm_content)
            .and_then(|found| found.get(1))
            .unwrap_or_default();
        let ext = js_regex!(r"<a:ext\b([^>]*)\/?")
            .exec(xfrm_content)
            .and_then(|found| found.get(1))
            .unwrap_or_default();
        let number = |pattern: &jscompat::JsRegex, from: &str| {
            parse_int(
                pattern
                    .exec(from)
                    .and_then(|found| found.get(1))
                    .unwrap_or_default(),
                Radix::Ten,
            )
        };
        let x = number(js_regex!(r#"\bx="([^"]*)""#), off);
        let y = number(js_regex!(r#"\by="([^"]*)""#), off);
        let cx = number(js_regex!(r#"\bcx="([^"]*)""#), ext);
        let cy = number(js_regex!(r#"\bcy="([^"]*)""#), ext);
        if x.is_nan() || y.is_nan() || cx.is_nan() || cy.is_nan() {
            continue;
        }
        results.push(LayoutPlaceholder {
            r#type: ph_type.to_owned(),
            idx: idx.to_owned(),
            x: JsNum(x),
            y: JsNum(y),
            cx: JsNum(cx),
            cy: JsNum(cy),
            hint: hint_for(ph_type),
        });
    }
    results
}

/// Enumerate all slideLayouts in the archive (sorted by number).
/// Only scans ppt/slideLayouts/slideLayoutN.xml files; does not rely on
/// presentation.xml's sldLayoutIdLst.
pub fn list_slide_layouts(archive: &PackageArchive) -> Vec<SlideLayoutInfo> {
    let mut paths: Vec<&str> = archive
        .entries()
        .keys()
        .filter(|path| js_regex!(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$").test(path))
        .collect();
    sort_by_number(&mut paths, |a, b| {
        let number = |path: &str| {
            parse_int(
                js_regex!(r"(\d+)")
                    .exec(path)
                    .and_then(|found| found.get(1))
                    .unwrap_or("0"),
                Radix::Ten,
            )
        };
        number(a) - number(b)
    });

    paths
        .into_iter()
        .map(|path| {
            let xml = archive.read_text(path).unwrap_or_default();
            // from the last '/' to four code units before the end ('.xml')
            let start = path.rfind('/').map_or(0, |at| at + 1);
            let file_name = path
                .get(start..path.len().saturating_sub(4))
                .unwrap_or_default();
            SlideLayoutInfo {
                path: path.to_owned(),
                name: parse_layout_name(&xml, file_name),
                layout_type: parse_layout_type(&xml),
                placeholders: parse_layout_placeholders(&xml),
            }
        })
        .collect()
}

// -- Blank slide insertion (with a given layout) -------------------------------

const SLIDE_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const SLIDE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
pub const LAYOUT_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout";

/// Generate the next unused slide path (current max number + 1).
fn next_slide_path(archive: &PackageArchive) -> String {
    let mut max = 0.0;
    for path in archive.entries().keys() {
        if let Some(found) = js_regex!(r"^ppt\/slides\/slide(\d+)\.xml$").exec(path) {
            max = math_max(max, parse_int(found.get(1).unwrap_or_default(), Radix::Ten));
        }
    }
    format!("ppt/slides/slide{}.xml", number_to_string(max + 1.0))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertLayoutSlideOptions {
    /// Insert after this slide index (0-based)
    pub source_index: f64,
    /// Target layout path (from listSlideLayouts), e.g. 'ppt/slideLayouts/slideLayout2.xml'
    pub layout_path: String,
}

const XMLDECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";

pub(crate) const EMPTY_SPTREE: &str = concat!(
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>",
    "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>",
    "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>"
);

/// One empty placeholder shape (<p:sp>) slice: explicit xfrm + empty paragraph
/// (like a new PowerPoint slide; the click hint is drawn by the edit canvas, not persisted).
pub fn placeholder_sp_xml(ph: &LayoutPlaceholder, id: f64) -> String {
    let type_attr = if ph.r#type.is_empty() {
        String::new()
    } else {
        format!(" type=\"{}\"", escape_xml_attr(&ph.r#type))
    };
    let idx_attr = if ph.idx.is_empty() {
        String::new()
    } else {
        format!(" idx=\"{}\"", escape_xml_attr(&ph.idx))
    };
    let name_idx = if ph.idx.is_empty() { "0" } else { &ph.idx };
    format!(
        "<p:sp>\
         <p:nvSpPr>\
         <p:cNvPr id=\"{id}\" name=\"ph{name_idx}\"/>\
         <p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr>\
         <p:nvPr><p:ph{type_attr}{idx_attr}/></p:nvPr>\
         </p:nvSpPr>\
         <p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm></p:spPr>\
         <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>\
         </p:sp>",
        id = number_to_string(id),
        x = number_to_string(ph.x.0),
        y = number_to_string(ph.y.0),
        cx = number_to_string(ph.cx.0),
        cy = number_to_string(ph.cy.0),
    )
}

/// Build blank slide XML containing the layout's placeholders.
fn build_slide_xml_with_placeholders(placeholders: &[LayoutPlaceholder]) -> String {
    let shapes: String = placeholders
        .iter()
        .enumerate()
        .map(|(i, ph)| placeholder_sp_xml(ph, (i + 2) as f64))
        .collect();
    format!(
        "{XMLDECL}<p:sld xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\">\
         <p:cSld><p:spTree>{EMPTY_SPTREE}{shapes}</p:spTree></p:cSld>\
         <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )
}

/// Insert a blank slide associated with a given layout.
/// The internal caller is responsible for:
///  1. writing the new path into the archive
///  2. registering it in presentation.xml + rels + [Content_Types].xml
///  3. parsing and splicing it into deck.slides
///
/// This function only performs the archive surgery of 1-3; parseSlide is up to the
/// caller (index.ts). Returns the new slide's path, or `None` on failure.
pub fn prepare_insert_slide_with_layout(
    archive: &mut PackageArchive,
    deck: &SlideDeck,
    source_index: usize,
    layout_path: &str,
) -> Result<Option<String>, String> {
    let Some(src) = deck.slides.get(source_index) else {
        return Ok(None);
    };
    if archive
        .read_text(layout_path)
        .is_none_or(|xml| xml.is_empty())
    {
        return Ok(None);
    }
    // asked before anything is written: a deck that cannot list the slide is left as it was
    if !can_list_slide(archive.read_text("ppt/presentation.xml").as_deref()) {
        return Ok(None);
    }

    // Parse the layout placeholders and build the new slide XML with placeholder text boxes
    let layout_xml = archive.read_text(layout_path).unwrap_or_default();
    let placeholders = parse_layout_placeholders(&layout_xml);
    let new_slide_xml = build_slide_xml_with_placeholders(&placeholders);
    drop(layout_xml);

    let new_path = next_slide_path(archive);
    archive
        .entries_mut()
        .set(new_path.clone(), new_slide_xml.into_bytes());

    // slide rels -> point at the chosen layout
    let rel_target = format!("../{}", slice_utf16(layout_path, 4.0, None)); // 'ppt/' -> '../'
    let rels_xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"{LAYOUT_REL_TYPE}\" Target=\"{}\"/>\
         </Relationships>",
        escape_xml_attr(&rel_target)
    );
    archive
        .entries_mut()
        .set(rels_path_for(&new_path), rels_xml.into_bytes());

    // [Content_Types].xml
    let ct_path = "[Content_Types].xml";
    if let Some(ct) = archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
        && !has_content_type_override(&ct, &new_path)
    {
        let next = replace_literal(
            &ct,
            "</Types>",
            &format!(
                "<Override PartName=\"/{new_path}\" ContentType=\"{SLIDE_CONTENT_TYPE}\"/></Types>"
            ),
        );
        archive.entries_mut().set(ct_path, next.into_bytes());
    }

    // presentation.xml.rels + presentation.xml
    let pres_rels_path = "ppt/_rels/presentation.xml.rels";
    let pres_path = "ppt/presentation.xml";
    let pres_rels = archive
        .read_text(pres_rels_path)
        .map(|text| text.into_owned());
    let pres = archive.read_text(pres_path).map(|text| text.into_owned());
    let (Some(pres_rels), Some(pres)) = (
        pres_rels.filter(|text| !text.is_empty()),
        pres.filter(|text| !text.is_empty()),
    ) else {
        return Ok(None);
    };

    let max_rid = max_relationship_id_number(&pres_rels);
    let new_rid = format!("rId{}", number_to_string(max_rid + 1.0));
    // Listed after the source slide
    let src_rid = archive
        .read_rels(pres_path)?
        .values()
        .find(|rel| resolve_target(pres_path, &rel.target) == crate::deck::slide_path(src))
        .map(|rel| rel.id.clone());
    let Some(next_pres) = with_slide_listed(&pres, &new_rid, src_rid.as_deref())
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let rel_entry = format!(
        "<Relationship Id=\"{new_rid}\" Type=\"{SLIDE_REL_TYPE}\" Target=\"{}\"/>",
        new_path.get("ppt/".len()..).unwrap_or_default()
    );
    archive.entries_mut().set(
        pres_rels_path,
        replace_literal(
            &pres_rels,
            "</Relationships>",
            &format!("{rel_entry}</Relationships>"),
        )
        .into_bytes(),
    );
    archive.entries_mut().set(pres_path, next_pres.into_bytes());

    Ok(Some(new_path))
}
