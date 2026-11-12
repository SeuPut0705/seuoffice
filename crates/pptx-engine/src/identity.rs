//! Durable ids (packages/pptx-engine/src/identity.ts), resolved from the
//! element's own bytes so they survive save and reopen, reparse, and group
//! or ungroup. An element is `e_<guid8>` from its a16:creationId, else
//! `e_<cNvPr id>`; a slide is `s_<n>` from its part path.
//!
//! The element search is scoped to the element's own `<p:cNvPr>`, the first
//! in the fragment: a group embeds its children's bytes, and a wrapper
//! without a creationId must not take a child's. Tags are read as XML reads
//! them (`attribute_of`: any quotes, white space around `=`, decoded once).

use std::sync::Arc;

use jscompat::{RegexLimit, is_js_space, js_regex, replace_first_with, truthy, try_js_regex};

use crate::types::{ByteAnchor, Slide, SlideElement};
use crate::with_element;
use crate::xml_utils::{
    ElementRange, attribute_of, creation_id_ext_xml, creation_id_xml, element_range,
};

/// The uri of the a:ext that holds a shape's a16:creationId.
const CREATION_ID_URI: &str = "{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}";
const CNVPR_CLOSE: &str = "</p:cNvPr>";

fn limit(error: RegexLimit) -> String {
    error.to_string()
}

/// The tag, with its closing `/>` turned into `>`.
fn opened(tag: &str) -> String {
    format!("{}>", tag.strip_suffix("/>").unwrap_or(tag))
}

/// The GUID of the creation id in `own` (a `<p:cNvPr>` and what it holds): the creationId inside
/// an a:ext whose uri is the creation id's.
fn creation_guid_of(own: &str) -> Result<Option<String>, String> {
    let ext_open = try_js_regex!(r#"<a:ext\b(?:[^>"']|"[^"]*"|'[^']*')*>"#);
    let creation_tag = try_js_regex!(r#"<(?:[^\s/>:]+:)?creationId\b(?:[^>"']|"[^"]*"|'[^']*')*>"#);
    for open in ext_open.try_find_iter(own) {
        let open = open.map_err(limit)?;
        if attribute_of(open.as_str(), "uri").as_deref() != Some(CREATION_ID_URI) {
            continue;
        }
        let Some(ext) = element_range(own, "a:ext", open.start())? else {
            continue;
        };
        let content = own
            .get(ext.content_start..ext.content_end)
            .unwrap_or_default();
        for tag in creation_tag.try_find_iter(content) {
            let tag = tag.map_err(limit)?;
            let id = attribute_of(tag.as_str(), "id").unwrap_or_default();
            if let Some(guid) = js_regex!(r"^\{?([0-9A-Fa-f-]{36})\}?$")
                .exec(&id)
                .and_then(|found| found.get(1).map(str::to_owned))
            {
                return Ok(Some(guid));
            }
        }
    }
    Ok(None)
}

/// `xml` with every creation id given a new GUID, however the id is written. `next_uuid` is
/// `crypto.randomUUID()`, drawn once per creation id rewritten.
pub fn with_fresh_creation_ids(
    xml: &str,
    mut next_uuid: impl FnMut() -> String,
) -> Result<String, String> {
    let creation_tag = try_js_regex!(r#"<(?:[^\s/>:]+:)?creationId\b(?:[^>"']|"[^"]*"|'[^']*')*>"#);
    creation_tag
        .try_replace_all(xml, |found| {
            let tag = found.as_str();
            let id = attribute_of(tag, "id").unwrap_or_default();
            if !js_regex!(r"^\{?([0-9A-Fa-f-]{36})\}?$").test(&id) {
                return tag.to_owned();
            }
            replace_first_with(
                js_regex!(r#"(\sid\s*=\s*)(["'])[^"']*\2"#),
                tag,
                |id_attr| {
                    format!(
                        "{}{}{{{}}}{}",
                        id_attr.get(1).unwrap_or_default(),
                        id_attr.get(2).unwrap_or_default(),
                        next_uuid().to_uppercase(),
                        id_attr.get(2).unwrap_or_default(),
                    )
                },
            )
        })
        .map_err(limit)
}

/// The own `<p:cNvPr>` block of `xml`: its first cNvPr, from the open tag through its end tag.
fn own_cnvpr(xml: &str, from: usize) -> Result<Option<ElementRange>, String> {
    element_range(xml, "p:cNvPr", from)
}

/// The numeric id a `<p:cNvPr>` open tag gives, however it is quoted.
fn cnvpr_number(open_tag: &str) -> Option<String> {
    attribute_of(open_tag, "id")
        .filter(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

/// `el.anchor?.originalXml`, `None` where JavaScript reads it as false.
fn xml_of(el: &SlideElement) -> Option<&str> {
    truthy(with_element!(el, e => e.anchor.as_ref().map(|anchor| &*anchor.original_xml)))
}

/// `el.nvId`, the text of the element's `<p:cNvPr id>`.
fn nv_id_of(el: &SlideElement) -> Option<&str> {
    with_element!(el, e => e.nv_id.as_deref())
}

/// `el.anchor`, to be written.
fn anchor_mut(el: &mut SlideElement) -> Option<&mut ByteAnchor> {
    with_element!(el, e => e.anchor.as_mut())
}

/// `e_<nvId>`, `None` without an nvId (`nvId != null` in the TypeScript).
fn nv_id_form(el: &SlideElement) -> Option<String> {
    nv_id_of(el).map(|nv_id| format!("e_{nv_id}"))
}

/// `e_${guid.slice(0, 8).toLowerCase()}`: the GUID is ASCII.
fn guid_form(guid: &str) -> String {
    format!("e_{}", guid.get(..8).unwrap_or(guid).to_ascii_lowercase())
}

pub fn element_durable_id(el: &SlideElement) -> Result<Option<String>, String> {
    let Some(xml) = xml_of(el) else {
        // a group child has no byte slice of its own; its persisted cNvPr id,
        // parsed as nvId, still names it
        return Ok(nv_id_form(el));
    };
    let Some(own) = own_cnvpr(xml, 0)? else {
        return Ok(None);
    };
    let block = xml.get(own.start..own.end).unwrap_or_default();
    if let Some(guid) = creation_guid_of(block)? {
        return Ok(Some(guid_form(&guid)));
    }
    Ok(cnvpr_number(block).map(|n| format!("e_{n}")))
}

pub fn slide_durable_id(slide: &Slide) -> String {
    if let Some(number) =
        js_regex!(r"slide(\d+)\.xml$").exec(slide.path.as_deref().unwrap_or_default())
    {
        return format!("s_{}", number.get(1).unwrap_or_default());
    }
    // the TypeScript class matches each UTF-16 unit, so a character outside
    // the BMP becomes two underscores
    let flat = js_regex!(r"[^a-zA-Z0-9]")
        .replace_all(slide.path.as_deref().unwrap_or_default(), |other| {
            "_".repeat(other.as_str().encode_utf16().count())
        });
    format!("s_{flat}")
}

/// The pre-upgrade form `e_<cNvPr id>`, whether or not a creationId exists:
/// it stays an alias after `ensureCreationId` mints a GUID.
pub fn element_cnvpr_id(el: &SlideElement) -> Result<Option<String>, String> {
    let Some(xml) = xml_of(el) else {
        return Ok(nv_id_form(el));
    };
    let Some(own) = own_cnvpr(xml, 0)? else {
        return Ok(None);
    };
    let block = xml.get(own.start..own.end).unwrap_or_default();
    Ok(cnvpr_number(block).map(|n| format!("e_{n}")))
}

/// A ref matches the parse-time id, the durable id or the cNvPr form.
pub fn matches_element_ref(el: &SlideElement, id: &str) -> Result<bool, String> {
    Ok(el.id() == id
        || element_durable_id(el)?.as_deref() == Some(id)
        || element_cnvpr_id(el)?.as_deref() == Some(id))
}

/// Mints an a16:creationId into the element's own `<p:cNvPr>` when it lacks
/// one. `uuid` is what `crypto.randomUUID()` gives `creationIdXml` and
/// `creationIdExtXml`; at most one is drawn.
pub fn ensure_creation_id(el: &mut SlideElement, uuid: &str) -> Result<(), String> {
    let Some(anchor) = anchor_mut(el) else {
        return Ok(());
    };
    if let Some(next) = with_creation_id(&anchor.original_xml, uuid)? {
        anchor.original_xml = Arc::from(next);
    }
    Ok(())
}

/// The slice `ensureCreationId` leaves, `None` where it returns early.
fn with_creation_id(xml: &str, uuid: &str) -> Result<Option<String>, String> {
    if xml.is_empty() {
        return Ok(None);
    }
    let Some(own) = own_cnvpr(xml, 0)? else {
        return Ok(None);
    };
    let before = xml.get(..own.start).unwrap_or_default();
    if own.content_start == own.end {
        // self-closing: expand into a tag pair carrying the extLst
        let head = opened(xml.get(own.start..own.end).unwrap_or_default());
        return Ok(Some(format!(
            "{before}{head}{}{CNVPR_CLOSE}{}",
            creation_id_xml(uuid),
            xml.get(own.end..).unwrap_or_default(),
        )));
    }
    if creation_guid_of(xml.get(own.start..own.end).unwrap_or_default())?.is_some() {
        return Ok(None);
    }
    // extLst has maxOccurs=1 and is cNvPr's last child: merge into an existing one, a list
    // that ends where cNvPr's content ends. An earlier one belongs to a nested hlinkClick or
    // hlinkHover and must not receive the GUID. However the list is written (empty, with
    // attributes, with white space in its tags) it is the same list.
    let content = xml
        .get(own.content_start..own.content_end)
        .unwrap_or_default();
    let content_end = own.content_start + content.trim_end_matches(is_js_space).len();
    let mut list = element_range(xml, "a:extLst", own.content_start)?;
    while let Some(found) = list {
        if found.end > content_end {
            break;
        }
        if found.end == content_end {
            let ext = creation_id_ext_xml(uuid);
            return Ok(Some(if found.content_start == found.end {
                format!(
                    "{}{}{ext}</a:extLst>{}",
                    xml.get(..found.start).unwrap_or_default(),
                    opened(xml.get(found.start..found.end).unwrap_or_default()),
                    xml.get(found.end..).unwrap_or_default(),
                )
            } else {
                format!(
                    "{}{ext}{}",
                    xml.get(..found.content_end).unwrap_or_default(),
                    xml.get(found.content_end..).unwrap_or_default(),
                )
            }));
        }
        list = element_range(xml, "a:extLst", found.end)?;
    }
    Ok(Some(format!(
        "{}{}{}",
        xml.get(..own.content_end).unwrap_or_default(),
        creation_id_xml(uuid),
        xml.get(own.content_end..).unwrap_or_default(),
    )))
}

/// The `<p:cNvPr>` block (open tag through end tag) whose own id attribute is exactly `id`. The
/// id is whatever the deck says, so it is compared as text, never built into a pattern.
fn cnvpr_with_id<'x>(xml: &'x str, id: &str) -> Result<Option<&'x str>, String> {
    for open in js_regex!(r"<p:cNvPr\b[^>]*?(\/?)>").find_iter(xml) {
        if attribute_of(open.as_str(), "id").as_deref() != Some(id) {
            continue;
        }
        return Ok(own_cnvpr(xml, open.start())?.and_then(|own| xml.get(own.start..own.end)));
    }
    Ok(None)
}

/// Durable id of a group child: its bytes, creationId included, live in the
/// group's slice, so its `<p:cNvPr>` is found there by nvId. Falls back to
/// `element_durable_id` of the child.
pub fn group_child_durable_id(
    grp: &SlideElement,
    child: &SlideElement,
) -> Result<Option<String>, String> {
    if let (Some(xml), Some(nv_id)) = (xml_of(grp), nv_id_of(child))
        && let Some(own) = cnvpr_with_id(xml, nv_id)?
        && let Some(guid) = creation_guid_of(own)?
    {
        return Ok(Some(guid_form(&guid)));
    }
    element_durable_id(child)
}
