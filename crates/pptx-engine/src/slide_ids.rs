//! Slide ids of a presentation part (packages/pptx-engine/src/slide-ids.ts).

use std::collections::HashSet;
use std::fmt;

use jscompat::{js_regex, to_number};

use crate::xml_utils::attribute_of;

/// ST_SlideId is 256..2147483647.
const SLIDE_ID_MIN: u32 = 256;
const SLIDE_ID_MAX: u32 = 2_147_483_647;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlideIdSpaceExhausted;

impl fmt::Display for SlideIdSpaceExhausted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("pptx: slide id space exhausted")
    }
}

impl std::error::Error for SlideIdSpaceExhausted {}

/// The next p:sldId/@id: the highest used plus one, or the lowest free id
/// once the deck sits at the ceiling.
pub fn next_slide_id(pres_xml: &str) -> Result<u32, SlideIdSpaceExhausted> {
    let mut used = HashSet::new();
    // The attribute named `id` itself (not `r:id`, whose value may be digits too),
    // with the white space XML allows around `=`.
    for found in
        js_regex!(r#"<p:sldId\s(?:[^>]*\s)?id\s*=\s*(?:"(\d+)"|'(\d+)')"#).find_iter(pres_xml)
    {
        // Out-of-range values are invalid per ST_SlideId; ignoring them keeps
        // a single hostile attribute from forcing the ceiling scan below.
        let n = to_number(found.get(1).or(found.get(2)).unwrap_or_default());
        if n >= f64::from(SLIDE_ID_MIN) && n <= f64::from(SLIDE_ID_MAX) {
            used.insert(n as u32);
        }
    }
    let max = used.iter().copied().max().unwrap_or(SLIDE_ID_MIN - 1);
    let mut id = max + 1;
    if id > SLIDE_ID_MAX {
        id = SLIDE_ID_MIN;
        while used.contains(&id) {
            id += 1;
            if id > SLIDE_ID_MAX {
                return Err(SlideIdSpaceExhausted);
            }
        }
    }
    Ok(id)
}

/// The slide list of presentation.xml as this engine writes to it: `p:` prefixed, with content or empty.
fn slide_list_re() -> &'static jscompat::JsRegex {
    js_regex!(r"<p:sldIdLst\s*>[\s\S]*?<\/p:sldIdLst\s*>")
}

/// The entry of the slide whose relationship is `rid`, with its offset in presentation.xml.
fn entry_of<'t>(pres_xml: &'t str, rid: &str) -> Option<(usize, &'t str)> {
    let list = slide_list_re().exec(pres_xml)?;
    for entry in
        js_regex!(r"<p:sldId\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldId\s*>)", "g").find_iter(list.as_str())
    {
        if attribute_of(entry.as_str(), "r:id").as_deref() == Some(rid) {
            let at = list.start() + entry.start();
            return Some((at, pres_xml.get(at..at + entry.as_str().len())?));
        }
    }
    None
}

/// Whether a slide can be added to this presentation.xml: not when its slide list is not
/// written with the `p:` prefix. Callers ask before they write anything.
pub fn can_list_slide(pres_xml: Option<&str>) -> bool {
    pres_xml.is_some_and(|xml| slide_list_re().test(xml))
}

/// presentation.xml with the slide of relationship `rid` listed right after the slide of
/// `after_rid` (at the end when that one is not listed), under a slide id not in use. `None`
/// when the list cannot be written to (`can_list_slide`).
pub fn with_slide_listed(
    pres_xml: &str,
    rid: &str,
    after_rid: Option<&str>,
) -> Result<Option<String>, SlideIdSpaceExhausted> {
    let Some(list) = slide_list_re().exec(pres_xml) else {
        return Ok(None);
    };
    let mut at = list.start() + list.as_str().rfind("</p:sldIdLst").unwrap_or_default();
    if let Some((entry_at, entry)) = after_rid.and_then(|after| entry_of(pres_xml, after)) {
        at = entry_at + entry.len();
    }
    let added = format!(
        r#"<p:sldId id="{}" r:id="{rid}"/>"#,
        next_slide_id(pres_xml)?
    );
    Ok(Some(format!(
        "{}{added}{}",
        pres_xml.get(..at).unwrap_or_default(),
        pres_xml.get(at..).unwrap_or_default(),
    )))
}

/// presentation.xml without the entry of the slide whose relationship is `rid`. `None` when
/// the slide is not listed.
pub fn with_slide_unlisted(pres_xml: &str, rid: &str) -> Option<String> {
    let (at, entry) = entry_of(pres_xml, rid)?;
    Some(format!(
        "{}{}",
        pres_xml.get(..at)?,
        pres_xml.get(at + entry.len()..)?,
    ))
}
