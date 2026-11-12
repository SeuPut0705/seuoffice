//! Built-in standard slide layouts, PowerPoint's core set
//! (packages/pptx-engine/src/builtin-layouts.ts).
//!
//! AI-generated decks usually ship a single empty layout, leaving the layout
//! picker useless. These definitions mirror the Office default template's
//! placeholder geometry (16:9 base, scaled to the actual slide size) and are
//! injected into the package on first use: layout part + rels + [Content_Types]
//! override + slideMaster registration (rels + sldLayoutIdLst), so the result
//! is a regular layout PowerPoint also understands.

use std::collections::HashSet;

use jscompat::{
    JsNum, js_regex, math_max, math_round, number_to_string, replace_first, replace_first_string,
    slice_utf16, to_number,
};
use serde::Serialize;

use crate::layout::{
    EMPTY_SPTREE, LAYOUT_REL_TYPE, LayoutPlaceholder, SlideLayoutInfo, hint_for,
    list_slide_layouts, placeholder_sp_xml, replace_literal,
};
use crate::types::SlideSize;
use crate::xml_utils::{has_content_type_override, max_relationship_id_number};
use crate::zip::{PackageArchive, rels_path_for, resolve_target};

const XMLDECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const MASTER_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster";
const LAYOUT_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";

/// Virtual layout-path prefix offered by the UI before the layout exists in the package
pub const BUILTIN_LAYOUT_PREFIX: &str = "builtin:";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct BuiltinPh {
    #[serde(rename = "type")]
    pub r#type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idx: Option<&'static str>,
    /// Geometry in the Office 16:9 base (12192000x6858000 EMU), scaled to the deck size on use
    #[serde(serialize_with = "serialize_num")]
    pub x: f64,
    #[serde(serialize_with = "serialize_num")]
    pub y: f64,
    #[serde(serialize_with = "serialize_num")]
    pub cx: f64,
    #[serde(serialize_with = "serialize_num")]
    pub cy: f64,
}

/// A whole number crosses JSON as an integer, as `JSON.stringify` writes it.
fn serialize_num<S: serde::Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    JsNum(*value).serialize(serializer)
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct BuiltinLayoutDef {
    pub key: &'static str,
    /// Canonical <p:cSld name>: PowerPoint's English layout name (the UI localizes known names)
    pub name: &'static str,
    /// <p:sldLayout type>
    #[serde(rename = "type")]
    pub r#type: &'static str,
    pub placeholders: &'static [BuiltinPh],
}

const BASE_CX: f64 = 12192000.0;
const BASE_CY: f64 = 6858000.0;
const TITLE: BuiltinPh = BuiltinPh {
    r#type: "title",
    idx: None,
    x: 838200.0,
    y: 365125.0,
    cx: 10515600.0,
    cy: 1325563.0,
};
const BODY: BuiltinPh = BuiltinPh {
    r#type: "body",
    idx: Some("1"),
    x: 838200.0,
    y: 1825625.0,
    cx: 10515600.0,
    cy: 4351338.0,
};

pub const BUILTIN_LAYOUTS: &[BuiltinLayoutDef] = &[
    BuiltinLayoutDef {
        key: "titleSlide",
        name: "Title Slide",
        r#type: "title",
        placeholders: &[
            BuiltinPh {
                r#type: "ctrTitle",
                idx: None,
                x: 1524000.0,
                y: 1122363.0,
                cx: 9144000.0,
                cy: 2387600.0,
            },
            BuiltinPh {
                r#type: "subTitle",
                idx: Some("1"),
                x: 1524000.0,
                y: 3602038.0,
                cx: 9144000.0,
                cy: 1655762.0,
            },
        ],
    },
    BuiltinLayoutDef {
        key: "titleContent",
        name: "Title and Content",
        r#type: "obj",
        placeholders: &[TITLE, BODY],
    },
    BuiltinLayoutDef {
        key: "sectionHeader",
        name: "Section Header",
        r#type: "secHead",
        placeholders: &[
            BuiltinPh {
                r#type: "title",
                idx: None,
                x: 831850.0,
                y: 4589463.0,
                cx: 10515600.0,
                cy: 1500187.0,
            },
            BuiltinPh {
                r#type: "body",
                idx: Some("1"),
                x: 831850.0,
                y: 1709738.0,
                cx: 10515600.0,
                cy: 2852737.0,
            },
        ],
    },
    BuiltinLayoutDef {
        key: "twoContent",
        name: "Two Content",
        r#type: "twoObj",
        placeholders: &[
            TITLE,
            BuiltinPh {
                r#type: "body",
                idx: Some("1"),
                x: 838200.0,
                y: 1825625.0,
                cx: 5157787.0,
                cy: 4351338.0,
            },
            BuiltinPh {
                r#type: "body",
                idx: Some("2"),
                x: 6172200.0,
                y: 1825625.0,
                cx: 5181600.0,
                cy: 4351338.0,
            },
        ],
    },
    BuiltinLayoutDef {
        key: "titleOnly",
        name: "Title Only",
        r#type: "titleOnly",
        placeholders: &[TITLE],
    },
    BuiltinLayoutDef {
        key: "blank",
        name: "Blank",
        r#type: "blank",
        placeholders: &[],
    },
];

fn scale_ph(ph: &BuiltinPh, size: &SlideSize) -> LayoutPlaceholder {
    let sx = |v: f64| math_round(v / BASE_CX * size.cx.0);
    let sy = |v: f64| math_round(v / BASE_CY * size.cy.0);
    LayoutPlaceholder {
        r#type: ph.r#type.to_owned(),
        idx: ph.idx.unwrap_or_default().to_owned(),
        x: JsNum(sx(ph.x)),
        y: JsNum(sy(ph.y)),
        cx: JsNum(sx(ph.cx)),
        cy: JsNum(sy(ph.cy)),
        hint: hint_for(ph.r#type),
    }
}

/// Whether the picker should offer the built-in set: true while no foreign
/// (non-built-in-named) layout carries placeholders. Judging by name keeps
/// already-injected built-ins from turning the offer off - otherwise the rest
/// of the standard set would vanish after the first one is used.
pub fn should_offer_builtin_layouts(layouts: &[SlideLayoutInfo]) -> bool {
    let names: HashSet<&str> = BUILTIN_LAYOUTS.iter().map(|d| d.name).collect();
    !layouts
        .iter()
        .any(|l| !l.placeholders.is_empty() && !names.contains(l.name.as_str()))
}

/// Virtual SlideLayoutInfo entries for the layout picker (path = 'builtin:<key>').
/// Definitions whose canonical name collides with an existing layout are skipped.
pub fn builtin_layout_infos(
    size: &SlideSize,
    existing_names: &HashSet<String>,
) -> Vec<SlideLayoutInfo> {
    BUILTIN_LAYOUTS
        .iter()
        .filter(|d| !existing_names.contains(d.name))
        .map(|d| SlideLayoutInfo {
            path: format!("{BUILTIN_LAYOUT_PREFIX}{}", d.key),
            name: d.name.to_owned(),
            layout_type: d.r#type.to_owned(),
            placeholders: d.placeholders.iter().map(|ph| scale_ph(ph, size)).collect(),
        })
        .collect()
}

fn build_layout_xml(def: &BuiltinLayoutDef, size: &SlideSize) -> String {
    let shapes: String = def
        .placeholders
        .iter()
        .enumerate()
        .map(|(i, ph)| placeholder_sp_xml(&scale_ph(ph, size), (i + 2) as f64))
        .collect();
    format!(
        "{XMLDECL}<p:sldLayout xmlns:a=\"{NS_A}\" xmlns:r=\"{NS_R}\" xmlns:p=\"{NS_P}\" type=\"{}\">\
         <p:cSld name=\"{}\"><p:spTree>{EMPTY_SPTREE}{shapes}</p:spTree></p:cSld>\
         <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>",
        def.r#type, def.name
    )
}

/// The slideMaster the deck's layouts hang off (via any layout's rels, else the first master part).
fn find_master_path(archive: &PackageArchive) -> Result<Option<String>, String> {
    for path in archive.entries().keys() {
        if !js_regex!(r"^ppt\/slideLayouts\/slideLayout\d+\.xml$").test(path) {
            continue;
        }
        for rel in archive.read_rels(path)?.values() {
            if rel.r#type == MASTER_REL_TYPE {
                return Ok(Some(resolve_target(path, &rel.target)));
            }
        }
    }
    let mut masters: Vec<&str> = archive
        .entries()
        .keys()
        .filter(|p| js_regex!(r"^ppt\/slideMasters\/slideMaster\d+\.xml$").test(p))
        .collect();
    // default sort: UTF-16 code units; these names are ASCII
    masters.sort_unstable();
    Ok(masters.first().map(|path| (*path).to_owned()))
}

/// Make sure a built-in layout exists in the package and return its path.
/// Idempotent: an existing layout with the same canonical name is reused.
/// Returns `None` for an unknown key or a package without a slideMaster.
pub fn ensure_builtin_layout(
    archive: &mut PackageArchive,
    size: &SlideSize,
    key: &str,
) -> Result<Option<String>, String> {
    let Some(def) = BUILTIN_LAYOUTS.iter().find(|d| d.key == key) else {
        return Ok(None);
    };
    if let Some(existing) = list_slide_layouts(archive)
        .into_iter()
        .find(|l| l.name == def.name)
    {
        return Ok(Some(existing.path));
    }

    let Some(master_path) = find_master_path(archive)?.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let master_xml = archive
        .read_text(&master_path)
        .map(|text| text.into_owned());
    let master_rels_path = rels_path_for(&master_path);
    let master_rels = archive
        .read_text(&master_rels_path)
        .map(|text| text.into_owned());
    let (Some(master_xml), Some(master_rels)) = (
        master_xml.filter(|text| !text.is_empty()),
        master_rels.filter(|text| !text.is_empty()),
    ) else {
        return Ok(None);
    };

    let mut max_layout = 0.0;
    for p in archive.entries().keys() {
        if let Some(found) = js_regex!(r"^ppt\/slideLayouts\/slideLayout(\d+)\.xml$").exec(p) {
            max_layout = math_max(max_layout, to_number(found.get(1).unwrap_or_default()));
        }
    }
    let layout_path = format!(
        "ppt/slideLayouts/slideLayout{}.xml",
        number_to_string(max_layout + 1.0)
    );

    archive.entries_mut().set(
        layout_path.clone(),
        build_layout_xml(def, size).into_bytes(),
    );
    let layout_rels = format!(
        "{XMLDECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"{MASTER_REL_TYPE}\" Target=\"../slideMasters/{}\"/>\
         </Relationships>",
        slice_utf16(&master_path, "ppt/slideMasters/".len() as f64, None)
    );
    archive
        .entries_mut()
        .set(rels_path_for(&layout_path), layout_rels.into_bytes());

    let ct_path = "[Content_Types].xml";
    if let Some(ct) = archive
        .read_text(ct_path)
        .filter(|ct| !ct.is_empty())
        .map(|ct| ct.into_owned())
        && !has_content_type_override(&ct, &layout_path)
    {
        let next = replace_first_string(
            &ct,
            "</Types>",
            &format!(
                "<Override PartName=\"/{layout_path}\" ContentType=\"{LAYOUT_CONTENT_TYPE}\"/></Types>"
            ),
        );
        archive.entries_mut().set(ct_path, next.into_bytes());
    }

    let max_rid = max_relationship_id_number(&master_rels);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    let next_rels = replace_first_string(
        &master_rels,
        "</Relationships>",
        &format!(
            "<Relationship Id=\"{rid}\" Type=\"{LAYOUT_REL_TYPE}\" Target=\"../slideLayouts/{}\"/></Relationships>",
            layout_path
                .get("ppt/slideLayouts/".len()..)
                .unwrap_or_default()
        ),
    );
    archive
        .entries_mut()
        .set(master_rels_path, next_rels.into_bytes());

    // sldLayoutId ids live in the >=2147483648 range per spec
    let mut max_id = 2147483648.0;
    for found in js_regex!(r#"<p:sldLayoutId\s[^>]*\bid="(\d+)""#, "g").find_iter(&master_xml) {
        max_id = math_max(max_id, to_number(found.get(1).unwrap_or_default()));
    }
    let id_tag = format!(
        "<p:sldLayoutId id=\"{}\" r:id=\"{rid}\"/>",
        number_to_string(max_id + 1.0)
    );
    let next_master = if master_xml.contains("</p:sldLayoutIdLst>") {
        replace_literal(
            &master_xml,
            "</p:sldLayoutIdLst>",
            &format!("{id_tag}</p:sldLayoutIdLst>"),
        )
    } else {
        replace_first(
            js_regex!(r"(<p:clrMap\b[^>]*\/>)"),
            1,
            &master_xml,
            &format!("$1<p:sldLayoutIdLst>{id_tag}</p:sldLayoutIdLst>"),
        )
    };
    archive
        .entries_mut()
        .set(master_path, next_master.into_bytes());
    Ok(Some(layout_path))
}
