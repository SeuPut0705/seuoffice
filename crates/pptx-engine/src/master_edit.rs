//! Port of packages/pptx-engine/src/master-edit.ts: the parts of the master
//! edit view and the parse of one of them as an editable slide.

use jscompat::{JsMap, Radix, js_regex, parse_int, slice_utf16, sort_by_number, truthy};
use serde::Serialize;

use crate::parse::{
    DecorationOptions, ParseContext, ParseContextData, SlideParseInput, Uids, parse_decorations,
    parse_slide,
};
use crate::placeholder::{parse_master_text_styles, parse_placeholder_map};
use crate::theme::{parse_clr_map, parse_theme};
use crate::types::Slide;
use crate::zip::{PackageArchive, resolve_target};

/// `kind` of a [`MasterPartInfo`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MasterPartKind {
    Master,
    Layout,
}

/// `MasterPartInfo`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterPartInfo {
    pub part_path: String,
    pub kind: MasterPartKind,
    pub name: String,
}

/// `partNum`
fn part_num(p: &str) -> f64 {
    let digits = js_regex!(r"(\d+)\.xml$")
        .exec(p)
        .and_then(|m| m.get(1))
        .unwrap_or("0");
    parse_int(digits, Radix::Ten)
}

/// `cSldName`
fn c_sld_name(xml: Option<&str>, fallback: String) -> String {
    let m = truthy(xml).and_then(|xml| js_regex!(r#"<p:cSld\s[^>]*name="([^"]*)""#).exec(xml));
    match truthy(m.and_then(|m| m.get(1))) {
        Some(name) => name.to_owned(),
        None => fallback,
    }
}

/// `listMasterParts`
pub fn list_master_parts(archive: &PackageArchive) -> Result<Vec<MasterPartInfo>, String> {
    let mut masters: Vec<&str> = archive
        .entries()
        .keys()
        .filter(|p| js_regex!(r"^ppt\/slideMasters\/slideMaster\d+\.xml$").test(p))
        .collect();
    sort_by_number(&mut masters, |a, b| part_num(a) - part_num(b));
    let mut out = Vec::new();
    for m in masters {
        out.push(MasterPartInfo {
            part_path: m.to_owned(),
            kind: MasterPartKind::Master,
            name: c_sld_name(archive.read_text(m).as_deref(), base_name(m)),
        });
        let mut layouts: Vec<String> = archive
            .read_rels(m)?
            .values()
            .filter(|r| r.r#type.ends_with("/slideLayout"))
            .map(|r| resolve_target(m, &r.target))
            .collect();
        sort_by_number(&mut layouts, |a, b| part_num(a) - part_num(b));
        for l in layouts {
            let name = c_sld_name(archive.read_text(&l).as_deref(), base_name(&l));
            out.push(MasterPartInfo {
                part_path: l,
                kind: MasterPartKind::Layout,
                name,
            });
        }
    }
    Ok(out)
}

/// `baseName`: `p.slice(p.lastIndexOf('/') + 1, -4)`, the second index
/// counted in UTF-16 code units.
fn base_name(p: &str) -> String {
    let after_slash = p
        .rfind('/')
        .map_or(p, |at| p.get(at + 1..).unwrap_or_default());
    slice_utf16(after_slash, 0.0, Some(-4.0))
}

/// `partMedia`
fn part_media(archive: &PackageArchive, part_path: &str) -> Result<JsMap<String>, String> {
    let mut media = JsMap::new();
    for rel in archive.read_rels(part_path)?.values() {
        if rel.r#type.ends_with("/image") {
            media.set(rel.id.clone(), resolve_target(part_path, &rel.target));
        }
    }
    Ok(media)
}

/// `parseMasterPart`. `uids` is the id counter parse.ts keeps in its module
/// (`uid`), here the caller's.
pub fn parse_master_part(
    archive: &PackageArchive,
    part_path: &str,
    uids: &Uids,
) -> Result<Option<Slide>, String> {
    let Some(xml) = archive.read_text(part_path).filter(|xml| !xml.is_empty()) else {
        return Ok(None);
    };
    let xml = xml.as_ref();
    let is_master = part_path.contains("/slideMasters/");

    let mut master_path: Option<String> = is_master.then(|| part_path.to_owned());
    if !is_master {
        for rel in archive.read_rels(part_path)?.values() {
            if rel.r#type.ends_with("/slideMaster") {
                master_path = Some(resolve_target(part_path, &rel.target));
                break;
            }
        }
    }

    let mut ctx = ParseContextData::default();
    if let Some(master_path) = master_path.as_deref() {
        for rel in archive.read_rels(master_path)?.values() {
            if rel.r#type.ends_with("/theme") {
                let theme_xml = archive.read_text(&resolve_target(master_path, &rel.target));
                if let Some(theme_xml) = truthy(theme_xml.as_deref()) {
                    ctx.theme = Some(parse_theme(theme_xml)?);
                }
                break;
            }
        }
    }
    ctx.media_rels = Some(part_media(archive, part_path)?);
    ctx.table_styles = archive
        .read_text("ppt/tableStyles.xml")
        .map(|text| text.into_owned());

    let master_xml = match master_path.as_deref() {
        Some(master_path) if !is_master => archive.read_text(master_path),
        _ => None,
    };
    let master_xml = master_xml.as_deref();
    if let Some(theme) = ctx.theme.as_mut() {
        theme.clr_map.assign(if is_master {
            parse_clr_map(Some(xml), None, None)
        } else {
            parse_clr_map(master_xml, Some(xml), None)
        });
    }
    if is_master {
        ctx.master_text_styles = Some(parse_master_text_styles(
            xml,
            ctx.theme.as_ref(),
            ctx.media_rels.as_ref(),
        ));
    } else if let Some(master_xml) = truthy(master_xml) {
        if let Some(master_path) = master_path.as_deref() {
            ctx.master_media_rels = Some(part_media(archive, master_path)?);
        }
        ctx.master_placeholders = Some(parse_placeholder_map(
            master_xml,
            ctx.theme.as_ref(),
            ctx.master_media_rels.as_ref(),
        ));
        ctx.master_text_styles = Some(parse_master_text_styles(
            master_xml,
            ctx.theme.as_ref(),
            ctx.master_media_rels.as_ref(),
        ));
        ctx.master_bg = Some(master_xml.to_owned());
    }

    let mut slide = parse_slide(SlideParseInput {
        path: part_path,
        slide_xml: xml,
        layout_path: None,
        master_path: master_path.as_deref(),
        ctx: ctx.context(uids),
    })?;

    if !is_master
        && let (Some(master_xml), Some(master_path)) = (truthy(master_xml), master_path.as_deref())
        && !js_regex!(r#"<p:sldLayout\b[^>]*showMasterSp=(?:"(?:0|false)"|'(?:0|false)')"#)
            .test(xml)
    {
        let media = part_media(archive, master_path)?;
        let empty = ParseContextData::default();
        let dctx = ParseContext {
            theme: ctx.theme.as_ref(),
            media_rels: Some(&media),
            ..empty.context(uids)
        };
        let dec = parse_decorations(master_xml, &dctx, &DecorationOptions::default())?;
        if !dec.is_empty() {
            slide.decorations.set(dec);
        }
    }
    Ok(Some(slide))
}
