//! Durable ids (packages/pptx-engine/src/identity.ts), resolved from the
//! element's own bytes so they survive save and reopen, reparse, and group
//! or ungroup. An element is `e_<guid8>` from its a16:creationId, else
//! `e_<cNvPr id>`; a slide is `s_<n>` from its part path.
//!
//! The element search is scoped to the element's own `<p:cNvPr>`, the first
//! in the fragment: a group embeds its children's bytes, and a wrapper
//! without a creationId must not take a child's.

use std::sync::Arc;

use jscompat::{JsMatch, JsRegex, TryJsRegex, js_regex, regex_escape, trim, truthy};

use crate::types::{ByteAnchor, Slide, SlideElement};
use crate::with_element;
use crate::xml_utils::{creation_id_ext_xml, creation_id_xml};

const CNVPR_CLOSE: &str = "</p:cNvPr>";

fn creation_id_re() -> &'static JsRegex {
    js_regex!(r#"<a16:creationId[^>]*\bid="\{?([0-9A-Fa-f-]{36})\}?""#)
}

fn cnvpr_open_re() -> &'static JsRegex {
    js_regex!(r"<p:cNvPr\b[^>]*?(\/?)>")
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

/// The element's own `<p:cNvPr>`: the tag when self-closing, else up to its
/// closing tag. Without one the TypeScript's `indexOf` gives -1 and the slice
/// ends at index 9, too short to hold a creationId: that reads as empty here.
fn own_cnvpr<'t>(xml: &'t str, open: &JsMatch<'t>) -> &'t str {
    if open.get(1) == Some("/") {
        return open.as_str();
    }
    let from = open.start();
    match xml.get(from..).and_then(|rest| rest.find(CNVPR_CLOSE)) {
        Some(at) => xml.get(from..from + at + CNVPR_CLOSE.len()).unwrap_or(""),
        None => "",
    }
}

/// `e_${creation[1].slice(0, 8).toLowerCase()}`: the capture is 36 ASCII
/// characters.
fn guid_form(creation: &JsMatch<'_>) -> String {
    let guid = creation.get(1).unwrap_or_default();
    format!("e_{}", guid.get(..8).unwrap_or(guid).to_ascii_lowercase())
}

/// `e_<n>` of the `id="<digits>"` in a `<p:cNvPr>` open tag.
fn cnvpr_id_form(open_tag: &str) -> Option<String> {
    let id = js_regex!(r#"\bid="(\d+)""#).exec(open_tag)?;
    Some(format!("e_{}", id.get(1).unwrap_or_default()))
}

pub fn element_durable_id(el: &SlideElement) -> Option<String> {
    let Some(xml) = xml_of(el) else {
        // a group child has no byte slice of its own; its persisted cNvPr id,
        // parsed as nvId, still names it
        return nv_id_form(el);
    };
    let open = cnvpr_open_re().exec(xml)?;
    let own = own_cnvpr(xml, &open);
    if let Some(creation) = creation_id_re().exec(own) {
        return Some(guid_form(&creation));
    }
    cnvpr_id_form(open.as_str())
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
pub fn element_cnvpr_id(el: &SlideElement) -> Option<String> {
    let Some(xml) = xml_of(el) else {
        return nv_id_form(el);
    };
    let open = cnvpr_open_re().exec(xml)?;
    cnvpr_id_form(open.as_str())
}

/// A ref matches the parse-time id, the durable id or the cNvPr form.
pub fn matches_element_ref(el: &SlideElement, id: &str) -> bool {
    el.id() == id
        || element_durable_id(el).as_deref() == Some(id)
        || element_cnvpr_id(el).as_deref() == Some(id)
}

/// Mints an a16:creationId into the element's own `<p:cNvPr>` when it lacks
/// one. `uuid` is what `crypto.randomUUID()` gives `creationIdXml` and
/// `creationIdExtXml`; at most one is drawn.
pub fn ensure_creation_id(el: &mut SlideElement, uuid: &str) {
    let Some(anchor) = anchor_mut(el) else {
        return;
    };
    if let Some(next) = with_creation_id(&anchor.original_xml, uuid) {
        anchor.original_xml = Arc::from(next);
    }
}

/// The slice `ensureCreationId` leaves, `None` where it returns early.
fn with_creation_id(xml: &str, uuid: &str) -> Option<String> {
    if xml.is_empty() {
        return None;
    }
    let open = cnvpr_open_re().exec(xml)?;
    if open.get(1) == Some("/") {
        // self-closing: expand into a tag pair carrying the extLst
        let tag = open.as_str();
        return Some(format!(
            "{}{}>{}{CNVPR_CLOSE}{}",
            xml.get(..open.start()).unwrap_or_default(),
            tag.strip_suffix("/>").unwrap_or(tag),
            creation_id_xml(uuid),
            xml.get(open.end()..).unwrap_or_default(),
        ));
    }
    let close = open.start() + xml.get(open.start()..)?.find(CNVPR_CLOSE)?;
    let own = xml.get(open.start()..close).unwrap_or_default();
    if creation_id_re().test(own) {
        return None;
    }
    // extLst has maxOccurs=1 and is cNvPr's last child: merge into an existing
    // one. An earlier list belongs to a nested hlinkClick or hlinkHover.
    // ledger cnvpr-own-extlst-forms: the TypeScript finds that list only by a
    // literal `</a:extLst>`, so a self-closing `<a:extLst/>` or a closing tag
    // with white space before its `>` got a second extLst, which
    // CT_NonVisualDrawingProps forbids.
    let own_list = js_regex!(r"<\/a:extLst\s*>|<a:extLst\b[^>]*?\/>")
        .find_iter(own)
        .last();
    if let Some(list) = own_list
        && trim(own.get(list.end()..).unwrap_or_default()).is_empty()
    {
        let at = open.start() + list.start();
        let before = xml.get(..at).unwrap_or_default();
        return Some(match list.as_str().strip_suffix("/>") {
            Some(head) => format!(
                "{before}{head}>{}</a:extLst>{}",
                creation_id_ext_xml(uuid),
                xml.get(at + list.as_str().len()..).unwrap_or_default(),
            ),
            None => format!(
                "{before}{}{}",
                creation_id_ext_xml(uuid),
                xml.get(at..).unwrap_or_default()
            ),
        });
    }
    Some(format!(
        "{}{}{}",
        xml.get(..close).unwrap_or_default(),
        creation_id_xml(uuid),
        xml.get(close..).unwrap_or_default(),
    ))
}

/// Durable id of a group child: its bytes, creationId included, live in the
/// group's slice, so its `<p:cNvPr>` is found there by nvId. Falls back to
/// `element_durable_id` of the child.
///
/// ledger group-child-nvid-pattern: the TypeScript pastes the nvId, which is
/// the document's `id` attribute, into a pattern as it is, so `(` throws and
/// `+21` matches no tag. Here the nvId is literal text.
pub fn group_child_durable_id(
    grp: &SlideElement,
    child: &SlideElement,
) -> Result<Option<String>, String> {
    if let (Some(xml), Some(nv_id)) = (xml_of(grp), nv_id_of(child)) {
        let regex = TryJsRegex::new(
            &format!(
                r#"<p:cNvPr\b[^>]*\bid="{}"[^>]*?(\/?)>"#,
                regex_escape(nv_id)
            ),
            "",
        )
        .map_err(|error| error.to_string())?;
        if let Some(open) = regex.try_exec(xml).map_err(|limit| limit.to_string())? {
            let own = own_cnvpr(xml, &open);
            if let Some(creation) = creation_id_re().exec(own) {
                return Ok(Some(guid_form(&creation)));
            }
        }
    }
    Ok(element_durable_id(child))
}
