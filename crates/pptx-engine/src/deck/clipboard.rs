//! packages/pptx-engine/src/index.ts, element clipboard (4179-4325):
//! `copyElementData` and `pasteElements`.

use std::collections::HashMap;

use jscompat::{
    JsMap, JsObject, TryJsRegex, index_of, js_regex, number_to_string, regex_escape,
    replace_first_with, to_number,
};
use serde::{Deserialize, Serialize};

use super::{OpenedPptx, append_raw_elements, patched_element_xml, random_uuid};
use crate::insert::next_c_nv_pr_id;
use crate::slide_transfer::{collect_part, import_clipboard_parts};
use crate::xml_utils::{escape_xml_attr, max_relationship_id_number};
use crate::zip::{rels_path_for, resolve_target};

/// One of `rels` of an `ElementClipboardItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipboardRel {
    pub rid: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
}

/// `ElementClipboardItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementClipboardItem {
    /// The element's current XML slice (incl. unsaved patches)
    pub xml: String,
    pub rels: Vec<ClipboardRel>,
    /// Dependency part bytes (base64, keyed by absolute path)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parts: Option<JsObject<String>>,
    /// ContentType per dependency: keyed by lower-case extension or by part path
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_types: Option<JsObject<String>>,
}

/// `shiftEmu` of `pasteElements`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ShiftEmu {
    pub dx: f64,
    pub dy: f64,
}

const RELS_START: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>";

/// `copyElementData`: the element's current XML and the relationships it
/// references. The element is `opened.deck.slides[slide_index].elements[element_index]`.
pub fn copy_element_data(
    opened: &mut OpenedPptx,
    slide_index: usize,
    element_index: usize,
) -> Result<ElementClipboardItem, String> {
    let OpenedPptx { deck, archive, .. } = opened;
    let slide = deck
        .slides
        .get_mut(slide_index)
        .ok_or_else(|| "no such slide".to_owned())?;
    let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
    let el = slide
        .elements
        .as_mut()
        .and_then(|elements| elements.get_mut(element_index))
        .ok_or_else(|| "no such element".to_owned())?;
    let xml = patched_element_xml(el);
    let slide_rels = archive.read_rels(&slide_path)?;
    let mut rels: Vec<ClipboardRel> = Vec::new();
    let mut parts: JsObject<String> = JsObject::new();
    let mut content_types: JsObject<String> = JsObject::new();
    let mut seen: Vec<String> = Vec::new();
    // Quote-agnostic like the other relationship scanners: a slide written by a
    // producer that prefers single quotes still names its rIds.
    for m in js_regex!(r#"\br:(?:embed|link|id)\s*=\s*(["'])(rId\d+)\1"#, "g").find_iter(&xml) {
        let rid = m.get(2).unwrap_or_default();
        if seen.iter().any(|s| s == rid) {
            continue;
        }
        seen.push(rid.to_owned());
        let Some(rel) = slide_rels.get(rid) else {
            continue;
        };
        let external = rel.target_mode.as_deref() == Some("External");
        let target = if external {
            rel.target.clone()
        } else {
            resolve_target(&slide_path, &rel.target)
        };
        // Slide-jump hyperlinks reference a whole slide; bundling it would drag in its
        // layout/master/theme graph, so keep those as path-only references
        if !external && !rel.r#type.ends_with("/slide") {
            collect_part(archive, &target, &mut parts, &mut content_types)?;
        }
        rels.push(ClipboardRel {
            rid: rid.to_owned(),
            r#type: rel.r#type.clone(),
            target,
            external: external.then_some(true),
        });
    }
    let has_parts = !parts.is_empty();
    Ok(ElementClipboardItem {
        xml,
        rels,
        parts: has_parts.then_some(parts),
        content_types: has_parts.then_some(content_types),
    })
}

/// `relTargetFromSlide`: 'ppt/media/image1.png' → '../media/image1.png'
fn rel_target_from_slide(abs_target: &str) -> String {
    match abs_target.strip_prefix("ppt/") {
        Some(rest) => format!("../{rest}"),
        None => format!("/{abs_target}"),
    }
}

/// `pasteElements`: land the bundled parts, do the relationship surgery,
/// renumber cNvPr ids, offset, append and reparse. `None` is the TypeScript
/// `null`; the new ids are returned and the slide is `opened.deck.slides[slide_index]`.
pub fn paste_elements(
    opened: &mut OpenedPptx,
    slide_index: usize,
    items: &[ElementClipboardItem],
    shift_emu: ShiftEmu,
) -> Result<Option<Vec<String>>, String> {
    let xmls = {
        let OpenedPptx { deck, archive, .. } = &mut *opened;
        let Some(slide) = deck.slides.get(slide_index) else {
            return Ok(None);
        };
        if items.is_empty() {
            return Ok(None);
        }
        let slide_path = slide.path.as_deref().unwrap_or("").to_owned();
        let rels_path = rels_path_for(&slide_path);
        let mut rels_xml = archive
            .read_text(&rels_path)
            .map_or_else(|| RELS_START.to_owned(), |text| text.into_owned());
        let mut rels_dirty = false;
        let mut max_rid = max_relationship_id_number(&rels_xml);
        // The target slide's existing relationships (type+resolved target → rId)
        let mut by_key: HashMap<String, String> = HashMap::new();
        for rel in archive.read_rels(&slide_path)?.values() {
            let abs = if rel.target_mode.as_deref() == Some("External") {
                rel.target.clone()
            } else {
                resolve_target(&slide_path, &rel.target)
            };
            by_key.insert(format!("{} {}", rel.r#type, abs), rel.id.clone());
        }

        // Land dependency parts the target deck is missing (all items at once)
        let mut bundled_parts: JsObject<String> = JsObject::new();
        let mut bundled_ct: JsObject<String> = JsObject::new();
        for item in items {
            if let Some(parts) = &item.parts {
                bundled_parts.assign(parts);
            }
            if let Some(types) = &item.content_types {
                bundled_ct.assign(types);
            }
        }
        let path_map: Option<JsMap<String>> = if bundled_parts.is_empty() {
            None
        } else {
            Some(import_clipboard_parts(
                archive,
                &bundled_parts,
                &bundled_ct,
            )?)
        };

        let mut next_id = next_c_nv_pr_id(slide);
        let mut xmls: Vec<String> = Vec::with_capacity(items.len());
        for item in items {
            let mut xml = item.xml.clone();
            for rel in &item.rels {
                let landed: String = if rel.external == Some(true) {
                    rel.target.clone()
                } else {
                    path_map
                        .as_ref()
                        .and_then(|map| map.get(&rel.target))
                        .cloned()
                        .unwrap_or_else(|| rel.target.clone())
                };
                let key = format!("{} {}", rel.r#type, landed);
                let rid = match by_key.get(&key) {
                    Some(rid) => rid.clone(),
                    None => {
                        max_rid += 1.0;
                        let rid = format!("rId{}", number_to_string(max_rid));
                        let external = rel.external == Some(true);
                        let target = if external {
                            rel.target.clone()
                        } else {
                            rel_target_from_slide(&landed)
                        };
                        let mode = if external {
                            " TargetMode=\"External\""
                        } else {
                            ""
                        };
                        // function replacement: an external target is a user-supplied URL
                        let entry = format!(
                            "<Relationship Id=\"{rid}\" Type=\"{}\" Target=\"{}\"{mode}/></Relationships>",
                            rel.r#type,
                            escape_xml_attr(&target)
                        );
                        if let Some(at) = index_of(&rels_xml, "</Relationships>", 0) {
                            let end = at + "</Relationships>".len();
                            rels_xml = format!(
                                "{}{entry}{}",
                                rels_xml.get(..at).unwrap_or_default(),
                                rels_xml.get(end..).unwrap_or_default()
                            );
                        }
                        rels_dirty = true;
                        by_key.insert(key, rid.clone());
                        rid
                    }
                };
                if rid != rel.rid {
                    let re = TryJsRegex::new(
                        &format!(r#"\br:(embed|link|id)="{}""#, regex_escape(&rel.rid)),
                        "g",
                    )
                    .map_err(|error| error.to_string())?;
                    // the new rId is written as given, `$` patterns not expanded
                    xml = re
                        .try_replace_all(&xml, |m| {
                            format!("r:{}=\"{rid}\"", m.get(1).unwrap_or_default())
                        })
                        .map_err(|error| error.to_string())?;
                }
            }
            xml = js_regex!(r#"(<p:cNvPr\s[^>]*\bid=["'])\d+(["'])"#, "g").replace_all(&xml, |m| {
                let out = format!(
                    "{}{}{}",
                    m.get(1).unwrap_or_default(),
                    number_to_string(next_id),
                    m.get(2).unwrap_or_default()
                );
                next_id += 1.0;
                out
            });
            // Pasted elements are new identities: mint fresh creationIds
            xml = js_regex!(
                r#"(<a16:creationId[^>]*\bid=")\{?[0-9A-Fa-f-]{36}\}?(")"#,
                "g"
            )
            .replace_all(&xml, |m| {
                format!(
                    "{}{{{}}}{}",
                    m.get(1).unwrap_or_default(),
                    random_uuid().to_uppercase(),
                    m.get(2).unwrap_or_default()
                )
            });
            // Offset only the outermost xfrm's off (group child coordinate systems stay put)
            xml = replace_first_with(js_regex!(r"<a:off\b[^>]*\/>"), &xml, |tag| {
                let shifted =
                    replace_first_with(js_regex!(r#"\bx="(-?\d+)""#), tag.as_str(), |m| {
                        format!(
                            "x=\"{}\"",
                            number_to_string(
                                to_number(m.get(1).unwrap_or_default()) + shift_emu.dx
                            )
                        )
                    });
                replace_first_with(js_regex!(r#"\by="(-?\d+)""#), &shifted, |m| {
                    format!(
                        "y=\"{}\"",
                        number_to_string(to_number(m.get(1).unwrap_or_default()) + shift_emu.dy)
                    )
                })
            });
            xmls.push(xml);
        }

        if rels_dirty {
            archive.entries_mut().set(rels_path, rels_xml.into_bytes());
        }
        xmls
    };
    append_raw_elements(opened, slide_index, &xmls)
}
