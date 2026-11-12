//! `assemble/meta.ts`: document metadata across the bridge.
//!
//! The bridge docx carries the ODT's people fields in `docProps/core.xml`
//! (`dc:creator` = `meta:initial-creator`, `cp:lastModifiedBy` = `dc:creator`),
//! so the editor's "remove personal information" scrubs them like any docx.
//! On save, `meta.xml` is touched only when that happened: the people fields
//! are then removed from it. Otherwise it keeps its bytes.

use jscompat::{js_regex, slice_utf16, trim};
use serde::{Deserialize, Serialize};

use crate::core::OdtDocument;
use crate::core::xml::{
    CloseVerdict, ElementFrame, ElementVisitor, OpenVerdict, decode_xml_entities, escape_xml_text,
    read_root, walk_elements,
};

/// `BridgeCoreProps`: people fields the bridge docx showed (`ext.assemble.core`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCoreProps {
    pub creator: Option<String>,
    pub last_modified_by: Option<String>,
}

/// `PEOPLE`
const PEOPLE: [&str; 3] = ["meta:initial-creator", "dc:creator", "meta:printed-by"];

/// Finds the first element of one canonical name: its text.
struct FieldVisitor<'a> {
    xml: &'a str,
    name: &'a str,
    out: Option<String>,
}

impl ElementVisitor for FieldVisitor<'_> {
    type Data = bool;

    fn open(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> OpenVerdict {
        if el.name != self.name {
            return OpenVerdict::Continue;
        }
        el.data = Some(true);
        OpenVerdict::Skip
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> CloseVerdict {
        if el.data != Some(true) {
            return CloseVerdict::Continue;
        }
        let range = el.range();
        self.out = Some(if range.self_closing {
            String::new()
        } else {
            decode_xml_entities(&self.xml[range.open_end..range.close_start])
        });
        CloseVerdict::Stop
    }
}

/// `metaField`: text of the first element named `name` (canonical) in
/// meta.xml, or `None`.
fn meta_field(meta_xml: &str, name: &str) -> Option<String> {
    let root = read_root(meta_xml)?;
    let mut visitor = FieldVisitor {
        xml: meta_xml,
        name,
        out: None,
    };
    walk_elements(meta_xml, &root.prefixes, &mut visitor, 0, meta_xml.len());
    visitor.out
}

/// `readMetaPeople`, over the text of `meta.xml` (`None`: the package has none).
pub fn read_meta_people_in(meta_xml: Option<&str>) -> BridgeCoreProps {
    let Some(meta) = meta_xml else {
        return BridgeCoreProps {
            creator: None,
            last_modified_by: None,
        };
    };
    BridgeCoreProps {
        creator: meta_field(meta, "meta:initial-creator"),
        last_modified_by: meta_field(meta, "dc:creator"),
    }
}

/// `readMetaPeople`
pub fn read_meta_people(doc: &OdtDocument) -> BridgeCoreProps {
    read_meta_people_in(doc.meta_xml.as_deref())
}

/// `toISOString()` of a time value in the range of a `Date`, with its
/// `.sss` dropped as the TypeScript's `replace(/\.\d{3}Z$/, 'Z')` does.
fn iso_seconds(ms: f64) -> Option<String> {
    let (year, month, day) = jscompat::utc_date_parts(ms)?;
    let time = ms.trunc() as i64;
    let of_day = time.rem_euclid(86_400_000);
    let hour = of_day / 3_600_000;
    let minute = of_day / 60_000 % 60;
    let second = of_day / 1000 % 60;
    let year_text = if (0.0..=9999.0).contains(&year) {
        format!("{:04}", year as i64)
    } else if year < 0.0 {
        format!("-{:06}", (-year) as i64)
    } else {
        format!("+{:06}", year as i64)
    };
    Some(format!(
        "{year_text}-{:02}-{:02}T{hour:02}:{minute:02}:{second:02}Z",
        month as i64 + 1,
        day as i64
    ))
}

/// The `iso` helper of `coreXmlFor`.
fn iso(v: Option<&str>) -> Option<String> {
    let v = v.filter(|v| !v.is_empty())?;
    if !js_regex!(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}").test(v) {
        return None;
    }
    let trimmed = trim(v);
    let parseable = if js_regex!(r"(?:[zZ]|[+-]\d{2}:?\d{2})$").test(trimmed) {
        trimmed.to_owned()
    } else {
        format!("{}Z", slice_utf16(trimmed, 0.0, Some(19.0)))
    };
    let ms = docx_engine::revision_xml::date_parse(&parseable);
    if ms.is_nan() {
        return None;
    }
    iso_seconds(ms)
}

/// `coreXmlFor`: `docProps/core.xml` for the bridge docx, or `None` when
/// meta.xml names nobody. `meta_xml` is the document's `meta.xml` (`doc.metaXml ?? ''`
/// is read from it).
pub fn core_xml_for_in(meta_xml: Option<&str>, people: &BridgeCoreProps) -> Option<String> {
    let nobody = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
    if nobody(&people.creator) && nobody(&people.last_modified_by) {
        return None;
    }
    let meta = meta_xml.unwrap_or("");
    let title = meta_field(meta, "dc:title");
    let created = meta_field(meta, "meta:creation-date");
    let modified = meta_field(meta, "dc:date");
    let c = iso(created.as_deref());
    let m = iso(modified.as_deref());
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n");
    out.push_str(
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" ",
    );
    out.push_str(
        "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" ",
    );
    out.push_str(
        "xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">",
    );
    if let Some(title) = title.as_deref().filter(|t| !t.is_empty()) {
        out.push_str(&format!("<dc:title>{}</dc:title>", escape_xml_text(title)));
    }
    out.push_str(&format!(
        "<dc:creator>{}</dc:creator>",
        escape_xml_text(people.creator.as_deref().unwrap_or(""))
    ));
    out.push_str(&format!(
        "<cp:lastModifiedBy>{}</cp:lastModifiedBy>",
        escape_xml_text(people.last_modified_by.as_deref().unwrap_or(""))
    ));
    if let Some(c) = c {
        out.push_str(&format!(
            "<dcterms:created xsi:type=\"dcterms:W3CDTF\">{c}</dcterms:created>"
        ));
    }
    if let Some(m) = m {
        out.push_str(&format!(
            "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{m}</dcterms:modified>"
        ));
    }
    out.push_str("</cp:coreProperties>");
    Some(out)
}

/// `coreXmlFor`
pub fn core_xml_for(doc: &OdtDocument, people: &BridgeCoreProps) -> Option<String> {
    core_xml_for_in(doc.meta_xml.as_deref(), people)
}

/// `coreField`: text of a core.xml element (by local name and prefix as the
/// engine writes them). The two tags the TypeScript asks for are the only
/// ones `personalInfoRemoved` uses.
fn core_field(core_xml: Option<&str>, tag: &str) -> Option<String> {
    let core_xml = core_xml?;
    let found = match tag {
        "dc:creator" => {
            js_regex!(r"<dc:creator(?:\s[^>]*)?(?:/>|>([\s\S]*?)</dc:creator>)").exec(core_xml)
        }
        "cp:lastModifiedBy" => {
            js_regex!(r"<cp:lastModifiedBy(?:\s[^>]*)?(?:/>|>([\s\S]*?)</cp:lastModifiedBy>)")
                .exec(core_xml)
        }
        _ => None,
    }?;
    Some(decode_xml_entities(found.get(1).unwrap_or("")))
}

/// `personalInfoRemoved`: whether the edited docx had personal information
/// removed: its settings ask for it, or a people field the bridge showed is
/// now empty or gone.
pub fn personal_info_removed(
    bridge: Option<&BridgeCoreProps>,
    edited_core_xml: Option<&str>,
    edited_flag: bool,
) -> bool {
    if edited_flag {
        return true;
    }
    let Some(bridge) = bridge else {
        return false;
    };
    let cleared = |was: &Option<String>, now: Option<String>| {
        was.as_deref().is_some_and(|was| !was.is_empty())
            && now.as_deref().is_none_or(str::is_empty)
    };
    cleared(&bridge.creator, core_field(edited_core_xml, "dc:creator"))
        || cleared(
            &bridge.last_modified_by,
            core_field(edited_core_xml, "cp:lastModifiedBy"),
        )
}

/// Collects the extents of the people fields.
struct ScrubVisitor {
    cuts: Vec<(usize, usize)>,
}

impl ElementVisitor for ScrubVisitor {
    type Data = bool;

    fn open(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> OpenVerdict {
        if PEOPLE.contains(&el.name.as_str()) {
            el.data = Some(true);
            return OpenVerdict::Skip;
        }
        OpenVerdict::Continue
    }

    fn close(
        &mut self,
        el: &mut ElementFrame<bool>,
        _parent: Option<&ElementFrame<bool>>,
    ) -> CloseVerdict {
        if el.data == Some(true) {
            let range = el.range();
            self.cuts.push((range.start, range.end));
        }
        CloseVerdict::Continue
    }
}

/// `scrubMetaXml`: meta.xml without its people fields (the same text when it
/// has none).
pub fn scrub_meta_xml(meta_xml: &str) -> String {
    let Some(root) = read_root(meta_xml) else {
        return meta_xml.to_owned();
    };
    let mut visitor = ScrubVisitor { cuts: Vec::new() };
    walk_elements(meta_xml, &root.prefixes, &mut visitor, 0, meta_xml.len());
    let mut cuts = visitor.cuts;
    // `cuts.sort((a, b) => b.start - a.start)`: the cuts do not overlap
    cuts.sort_by_key(|c| std::cmp::Reverse(c.0));
    let mut out = meta_xml.to_owned();
    for (start, end) in cuts {
        out = format!("{}{}", &out[..start], &out[end..]);
    }
    out
}
